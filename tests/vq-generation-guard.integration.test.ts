/**
 * Phase 10A-2 — paid-generation spend gate integration test (PROV-07).
 *
 * Runs ONLY against the explicit isolated local Postgres (TEST_DATABASE_URL); hard-
 * fails on any other host so it can never touch staging/prod. Skipped when unset.
 * Proves the money-critical gate end-to-end against real vq_config + real
 * vq_generation_requests windows: scope→ceiling mapping (D8), per-request credit
 * cap (D9), live hourly/daily windows, config override, and the append that feeds them.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

vi.mock("../server/db", () => {
  const url = process.env.TEST_DATABASE_URL || "";
  if (!url) return { db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } };
  const u = new URL(url);
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === "55432" && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 4 });
  return { db: drizzle(pool), pool };
});

const run = TEST_URL ? describe : describe.skip;

import { checkGenerationSpend, recordGenerationAttempt } from "../server/vault-quest/lib/generation-guard";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);
const NOW = 1_700_000_000_000; // fixed clock; DB createdAt = now() (recent, well within windows)

run("generation spend gate — local Postgres", () => {
  beforeEach(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("empty config → conservative defaults allow a normal single image", async () => {
    const v = await checkGenerationSpend({ requestedImages: 1, perImageCredits: 1, scope: "single", nowMs: NOW });
    expect(v.allow).toBe(true);
  });

  it("premium 3-candidate master (6cr) is allowed under the raised per-request cap (D9)", async () => {
    const v = await checkGenerationSpend({ requestedImages: 3, perImageCredits: 2, scope: "single", nowMs: NOW });
    expect(v.allow).toBe(true);
    expect(v.estimatedCredits).toBe(6);
  });

  it("single over the per-request credit cap is denied (429)", async () => {
    const v = await checkGenerationSpend({ requestedImages: 3, perImageCredits: 3, scope: "single", nowMs: NOW }); // 9 > 8, but 3 ≤ 3 images
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("per_request_ceiling");
    expect(v.http).toBe(429);
  });

  it("more images than the per-request count cap is denied", async () => {
    const v = await checkGenerationSpend({ requestedImages: 4, perImageCredits: 1, scope: "single", nowMs: NOW });
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("too_many_images");
  });

  it("family is capped by per-BATCH credits, NOT the 3-image count (D8)", async () => {
    // 10 images would trip the single/batch 3-image cap; as a family it's fine (10 ≤ 12).
    const ok = await checkGenerationSpend({ requestedImages: 10, perImageCredits: 1, scope: "family", nowMs: NOW });
    expect(ok.allow).toBe(true);
    // 13 credits exceeds the per-batch ceiling of 12.
    const no = await checkGenerationSpend({ requestedImages: 13, perImageCredits: 1, scope: "family", nowMs: NOW });
    expect(no.allow).toBe(false);
    expect(no.reason).toBe("per_request_ceiling");
  });

  it("live hourly window binds after enough recorded requests", async () => {
    for (let i = 0; i < 30; i++) {
      await recordGenerationAttempt({ generationType: "character-artwork", scope: "single", imagesProduced: 1, perImageCredits: 0, model: "nano_banana", characterId: `H-${i}`, nowMs: NOW + i });
    }
    const v = await checkGenerationSpend({ requestedImages: 1, perImageCredits: 1, scope: "single", nowMs: NOW });
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("hourly_limit");
  });

  it("live daily credit window binds after enough recorded spend", async () => {
    // one big recorded spend pushes creditsThisDay over the 50 default ceiling
    await recordGenerationAttempt({ generationType: "card-artwork", scope: "single", imagesProduced: 60, perImageCredits: 1, model: "nano_banana", cardId: "BIG", nowMs: NOW });
    const v = await checkGenerationSpend({ requestedImages: 1, perImageCredits: 1, scope: "single", nowMs: NOW });
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("daily_ceiling");
  });

  it("vq_config overrides the code defaults", async () => {
    await q("INSERT INTO vq_config(key,value) VALUES ($1,$2)", ["spend.max_credits_per_request", "2"]);
    const v = await checkGenerationSpend({ requestedImages: 3, perImageCredits: 1, scope: "single", nowMs: NOW }); // 3 > 2 now
    expect(v.allow).toBe(false);
    expect(v.reason).toBe("per_request_ceiling");
  });

  it("recordGenerationAttempt appends a row that the windows can see", async () => {
    await recordGenerationAttempt({ generationType: "card-artwork", scope: "single", imagesProduced: 2, perImageCredits: 1, model: "nano_banana", cardId: "REC", nowMs: NOW });
    const { rows } = await q("SELECT charged_credits, state, requested_count FROM vq_generation_requests", []);
    expect(rows.length).toBe(1);
    const r = rows[0] as { charged_credits: string; state: string; requested_count: number };
    expect(Number(r.charged_credits)).toBe(2);
    expect(r.state).toBe("completed");
  });
});
