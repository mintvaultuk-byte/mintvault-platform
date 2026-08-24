/**
 * Phase 10A-5 — ops status + feature-flag toggle integration tests against the
 * isolated LOCAL Postgres (TEST_DATABASE_URL, pinned/hard-failed; skipped
 * without it).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 4 });
  return { db: drizzle(pool), pool };
});
vi.mock("../server/anthropic-fetch", () => ({ anthropicFetch: vi.fn() }));

const run = TEST_URL ? describe : describe.skip;

import { setVqFeatureFlag, loadVqDbFlags } from "../server/vault-quest/lib/vq-feature-flags-store";
import { getExportJobCounts } from "../server/vault-quest/export-jobs";
import { getVqOpsStatus } from "../server/vault-quest/lib/vq-ops-status";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

run("vq ops status — local Postgres", () => {
  beforeEach(async () => {
    await q("DELETE FROM vq_feature_flags", []);
    await q("DELETE FROM vq_export_jobs", []);
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_feature_flags", []);
    await q("DELETE FROM vq_export_jobs", []);
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("setVqFeatureFlag inserts, then upserts (update not duplicate) with an audit trail", async () => {
    await setVqFeatureFlag("generation", false, "owner@test", "pausing spend");
    expect(await loadVqDbFlags()).toEqual({ generation: false });
    const row1 = (await q("SELECT reason, updated_by FROM vq_feature_flags WHERE feature='generation'", [])) as { rows: { reason: string; updated_by: string }[] };
    expect(row1.rows[0].reason).toBe("pausing spend");
    expect(row1.rows[0].updated_by).toBe("owner@test");

    await setVqFeatureFlag("generation", true, "owner@test", "resumed");
    expect(await loadVqDbFlags()).toEqual({ generation: true }); // updated, not a duplicate row
    const count = (await q("SELECT count(*)::int AS n FROM vq_feature_flags", [])) as { rows: { n: number }[] };
    expect(count.rows[0].n).toBe(1);
  });

  it("getExportJobCounts returns a bounded GROUP BY, not a row dump", async () => {
    await q(
      "INSERT INTO vq_export_jobs(kind, owner_admin_id, idempotency_key, state, requested_count, expires_at) VALUES ($1,$2,$3,$4,$5,now())",
      ["pack", "x", "k1", "completed", 1],
    );
    await q(
      "INSERT INTO vq_export_jobs(kind, owner_admin_id, idempotency_key, state, requested_count, expires_at) VALUES ($1,$2,$3,$4,$5,now())",
      ["pack", "x", "k2", "queued", 1],
    );
    const counts = await getExportJobCounts();
    expect(counts.durable).toMatchObject({ completed: 1, queued: 1 });
    expect(typeof counts.legacyInMemoryThisMachineOnly).toBe("number");
  });

  it("getVqOpsStatus composes everything into one honest, bounded snapshot", async () => {
    await setVqFeatureFlag("exports", false, "owner@test", "maintenance");
    const status = await getVqOpsStatus(Date.now());
    expect(status.machineId).toBeTruthy();
    const exportsFlag = status.features.find((f) => f.feature === "exports");
    expect(exportsFlag?.enabled).toBe(false);
    expect(exportsFlag?.source).toBe("db");
    const generationFlag = status.features.find((f) => f.feature === "generation");
    expect(generationFlag?.enabled).toBe(true); // untouched — default-on
    expect(status.providers.some((p) => p.id === "higgsfield")).toBe(true);
    expect(typeof status.spend.requestsThisHour).toBe("number");
    expect(status.exports.durable).not.toBeNull();
    expect(status.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
