/**
 * Phase 10A-2 verification — provider-create SPY proof.
 *
 * Mounts the REAL Vault Quest admin router and drives each of the four paid routes
 * over loopback with a vq_config ceiling forced to 0, then asserts the Higgsfield
 * create spy was NEVER called and the response was a 4xx block. This is the
 * end-to-end proof that the spend gate stops a blocked request BEFORE any charge.
 *
 * Isolated local Postgres only (TEST_DATABASE_URL, pinned/hard-failed); skipped
 * without it. No real R2/provider — the provider module is a spy, R2 is never hit
 * because every request is blocked before generation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const TEST_URL = process.env.TEST_DATABASE_URL || "";

// server/db → local plaintext pool pinned to the throwaway DB (the guard reads
// vq_config + vq_generation_requests through it).
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

// admin auth → pass-through (we are testing the spend gate, not auth).
vi.mock("../server/auth", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Spy the paid provider create; keep every other higgsfield export real, and force
// the connection to "connected" so routes reach the gate.
const createSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    generateHiggsfieldArtwork: createSpy,
    higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "" }),
  };
});

// Storage: only the pre-gate reads matter (every request is blocked at the gate).
vi.mock("../server/vault-quest/storage", () => {
  const approvedChar = { characterId: "GNV-F01-S1", familyId: "GNV-F01", stageNumber: 1, descriptionStatus: "approved" };
  return {
    vqStorage: {
      getCharacter: vi.fn(async () => approvedChar),
      listCharacters: vi.fn(async () => [approvedChar]),
      getCharacterBibleForCard: vi.fn(async () => undefined),
      getConfig: vi.fn(async () => ({})),
    },
  };
});

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

run("paid routes: blocked request makes ZERO provider create calls", () => {
  beforeAll(async () => {
    await q("DELETE FROM vq_config", []);
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES (\x27gen_master_portrait\x27,true,\x27test\x27),(\x27gen_action_pose\x27,true,\x27test\x27),(\x27gen_face_closeup\x27,true,\x27test\x27),(\x27gen_turnaround_sheet\x27,true,\x27test\x27),(\x27gen_colour_sheet\x27,true,\x27test\x27),(\x27gen_card_artwork\x27,true,\x27test\x27),(\x27gen_replacement\x27,true,\x27test\x27) ON CONFLICT (feature) DO UPDATE SET enabled = true", []); // Phase 2 correction A: gen_* now defaults OFF — these tests exercise OTHER gates and need every type enabled
    await q("DELETE FROM vq_generation_requests", []);
    // Force denial for every scope: 0 credits allowed per request AND per batch.
    await q("INSERT INTO vq_config(key,value) VALUES ($1,$2),($3,$4)", [
      "spend.max_credits_per_request", "0", "spend.max_credits_per_batch", "0",
    ]);
    const app = express();
    app.use(express.json());
    registerVaultQuestAdminRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });
  afterAll(async () => {
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_generation_requests", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  // Asserting reason==="per_request_ceiling" proves the 429 came from the spend gate
  // specifically (not an incidental earlier error) — i.e. the gate was reached, blocked,
  // and returned BEFORE the provider create. Not a vacuous "no call" pass.
  it("single character generate-artwork (master) is blocked before create", async () => {
    const r = await post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "master_portrait" });
    expect(r.status).toBe(429);
    expect((r.json as { reason?: string }).reason).toBe("per_request_ceiling");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("batch generate-artwork is blocked before create", async () => {
    const r = await post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork/batch", { count: 3 });
    expect(r.status).toBe(429);
    expect((r.json as { reason?: string }).reason).toBe("per_request_ceiling");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("family generate-artwork is blocked before create", async () => {
    const r = await post("/api/admin/vault-quest/characters/family/GNV-F01/generate-artwork", {});
    expect(r.status).toBe(429);
    expect((r.json as { reason?: string }).reason).toBe("per_request_ceiling");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("card ai/artwork is blocked before create", async () => {
    const r = await post("/api/admin/vault-quest/ai/artwork", { context: { cardId: "GNV-001", name: "Spy Test", element: "Fire" } });
    expect(r.status).toBe(429);
    expect((r.json as { reason?: string }).reason).toBe("per_request_ceiling");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("provider create was never called across all four blocked routes", () => {
    expect(createSpy).toHaveBeenCalledTimes(0);
  });
});
