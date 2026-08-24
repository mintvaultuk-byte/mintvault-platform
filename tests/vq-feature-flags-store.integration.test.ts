/**
 * Phase 10A-4 — DB adapter integration tests for the emergency feature-flag kill
 * switches, against the isolated LOCAL Postgres (TEST_DATABASE_URL, pinned/hard-
 * failed; skipped without it). Proves loadVqDbFlags/checkVqFeature against the
 * REAL vq_feature_flags table (migration 0011, already applied) — env precedence
 * itself is already exhaustively unit-tested in vq-feature-flags.test.ts.
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

const run = TEST_URL ? describe : describe.skip;

import { loadVqDbFlags, checkVqFeature } from "../server/vault-quest/lib/vq-feature-flags-store";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<unknown> }).query(s, a);

run("vq-feature-flags-store — local Postgres", () => {
  beforeEach(() => q("DELETE FROM vq_feature_flags", []));
  afterAll(async () => {
    await q("DELETE FROM vq_feature_flags", []);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("empty table → loadVqDbFlags returns {} (default-on preserved)", async () => {
    expect(await loadVqDbFlags()).toEqual({});
  });

  it("a real DB row is read back correctly", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled, reason) VALUES ($1,$2,$3)", ["generation", false, "test freeze"]);
    expect(await loadVqDbFlags()).toEqual({ generation: false });
  });

  it("checkVqFeature: no row → ok (default-on)", async () => {
    const r = await checkVqFeature("generation");
    expect(r.ok).toBe(true);
  });

  it("checkVqFeature: DB row disables the feature → not ok, 503 + Retry-After body", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled, reason) VALUES ($1,$2,$3)", ["generation", false, "owner paused spend"]);
    const r = await checkVqFeature("generation");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(503);
      expect(r.response.body.disabled).toBe(true);
      expect(r.response.body.reason).toBe("db_flag_off");
    }
  });

  it("env hard-off wins even with a DB row saying enabled (defence-in-depth across the two layers)", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled) VALUES ($1,$2)", ["exports", true]);
    const prev = process.env.VQ_EXPORTS_DISABLED;
    process.env.VQ_EXPORTS_DISABLED = "true";
    try {
      const r = await checkVqFeature("exports");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.response.body.reason).toBe("env_hard_off");
    } finally {
      if (prev === undefined) delete process.env.VQ_EXPORTS_DISABLED;
      else process.env.VQ_EXPORTS_DISABLED = prev;
    }
  });

  it("features are independent — disabling generation does not disable exports", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled) VALUES ($1,$2)", ["generation", false]);
    const gen = await checkVqFeature("generation");
    const exp = await checkVqFeature("exports");
    expect(gen.ok).toBe(false);
    expect(exp.ok).toBe(true);
  });
});
