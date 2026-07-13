/**
 * Phase 10A-1 verification — TRUE parallel concurrency against local Postgres.
 * The committed store test claims sequentially; this fires N claims / N creates
 * concurrently and asserts exactly ONE winner — the cross-machine single-winner
 * guarantee that the durable design rests on. Isolated local DB only; skipped
 * without TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "55432" && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: local test DB only, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});

const run = TEST_URL ? describe : describe.skip;

import { createOrGetExportJob, claimExportJob } from "../server/vault-quest/lib/export-job-store";
import { pool } from "../server/db";

const OWNER = "itest-concurrency";
const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<unknown> }).query(s, a);

run("durable export — parallel single-winner", () => {
  beforeEach(() => q("DELETE FROM vq_export_jobs WHERE owner_admin_id = $1", [OWNER]));
  afterAll(async () => {
    await q("DELETE FROM vq_export_jobs WHERE owner_admin_id = $1", [OWNER]);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("8 concurrent createOrGet for the same id-set yield exactly ONE non-deduped winner", async () => {
    const ids = ["C-1", "C-2", "C-3"];
    const results = await Promise.all(
      Array.from({ length: 8 }, () => createOrGetExportJob("pack", OWNER, ids, Date.now())),
    );
    const oks = results.filter((r) => r.ok);
    expect(oks.length).toBe(8); // none errored
    const fresh = oks.filter((r) => r.ok && !r.value.deduped);
    expect(fresh.length).toBe(1); // exactly one created; the rest deduped to it
    const jobIds = new Set(oks.map((r) => (r.ok ? r.value.job.jobId : "")));
    expect(jobIds.size).toBe(1); // everyone points at the same job
  });

  it("8 concurrent claims of one queued job yield exactly ONE processing winner", async () => {
    const created = await createOrGetExportJob("proxy", OWNER, ["X-1"], Date.now());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const jobId = created.value.job.jobId;
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimExportJob(jobId, `machine-${i}`, 60_000, Date.now())),
    );
    const winners = claims.filter((c) => c.ok);
    const conflicts = claims.filter((c) => !c.ok && c.reason === "conflict");
    expect(winners.length).toBe(1); // exactly one machine claims it
    expect(conflicts.length).toBe(7); // the rest lose cleanly
  });
});
