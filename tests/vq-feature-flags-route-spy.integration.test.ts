/**
 * Phase 10A-4 — END-TO-END emergency kill-switch proof: mounts the REAL Vault Quest
 * admin router and proves each gate actually stops a request before it does
 * anything expensive. Isolated local Postgres only; skipped without it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

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
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});

vi.mock("../server/auth", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const createSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateHiggsfieldArtwork: createSpy, higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "" }) };
});

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async () => ({
      characterId: "GNV-F01-S1", familyId: "GNV-F01", stageNumber: 1, cardId: "GNV-001",
      descriptionStatus: "approved", evolvesFromCharacterId: null, referencePack: null,
    })),
    getConfig: vi.fn(async () => ({ elements: {} })),
    listElementNames: vi.fn(async () => []),
    recordArtworkCandidate: vi.fn(async () => ({ id: 1 })),
    recordAiGeneration: vi.fn(async () => 1),
  },
}));

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async () => undefined),
  getR2Buffer: vi.fn(async () => null),
  getR2ObjectStream: vi.fn(async () => null),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function req(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

run("emergency feature kill switches — real router", () => {
  beforeAll(async () => {
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
  beforeEach(async () => {
    createSpy.mockClear();
    await q("DELETE FROM vq_feature_flags", []);
    // Phase 2 correction A: gen_* now defaults OFF. This file tests the ORIGINAL
    // three flags (generation/exports/writes) and their independence from each
    // other — not the per-type toggle itself (see vq-spend-guard-phase2 for that)
    // — so pre-enable the type this file's tests actually generate.
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', true, 'test')", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_generation_requests", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_feature_flags", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_generation_requests", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("baseline (no flags set): the paid route reaches the provider normally", async () => {
    const r = await req("POST", "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey: "baseline-1" });
    expect(r.status).not.toBe(503);
  });

  it("generation DB-disabled → 503 before spend/reservation/provider — the paid route never reaches Higgsfield", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled, reason) VALUES ($1,$2,$3)", ["generation", false, "owner paused"]);
    const r = await req("POST", "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey: "gen-off-1" });
    expect(r.status).toBe(503);
    expect((r.json as { disabled?: boolean; feature?: string }).disabled).toBe(true);
    expect((r.json as { feature?: string }).feature).toBe("generation");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("exports DB-disabled → the export-start route is blocked", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled) VALUES ($1,$2)", ["exports", false]);
    const r = await req("POST", "/api/admin/vault-quest/export/pack", { ids: ["GNV-001"] });
    expect(r.status).toBe(503);
    expect((r.json as { feature?: string }).feature).toBe("exports");
  });

  it("exports disabled does NOT block generation (features are independent)", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled) VALUES ($1,$2)", ["exports", false]);
    const r = await req("POST", "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey: "gen-ok-despite-exports-off" });
    expect(r.status).not.toBe(503);
  });

  it("shared provider token_expired state blocks the next generation before provider contact", async () => {
    await q(
      "INSERT INTO vq_config(key, value, updated_by) VALUES ($1,$2,$3),($4,$5,$6)",
      [
        "provider.higgsfield.last_status", "token_expired", "machine-a",
        "provider.higgsfield.last_auth_failure_at", "2026-07-14T12:00:00.000Z", "machine-a",
      ],
    );
    const r = await req("POST", "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey: "provider-locked-1" });
    expect(r.status).toBe(503);
    expect((r.json as { message?: string; providerStatus?: string }).message).toBe("Reconnect provider first");
    expect((r.json as { providerStatus?: string }).providerStatus).toBe("token_expired");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("writes DB-disabled → ANY mutating VQ route is frozen (global kill switch)", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled, reason) VALUES ($1,$2,$3)", ["writes", false, "emergency freeze"]);
    const r = await req("POST", "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", idempotencyKey: "writes-off-1" });
    expect(r.status).toBe(503);
    expect((r.json as { feature?: string }).feature).toBe("writes");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("writes DB-disabled → GET routes still work (reads are never frozen)", async () => {
    await q("INSERT INTO vq_feature_flags(feature, enabled) VALUES ($1,$2)", ["writes", false]);
    const r = await req("GET", "/api/admin/vault-quest/config");
    expect(r.status).not.toBe(503);
  });
});
