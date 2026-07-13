/**
 * Phase 10A D10 — END-TO-END provider-create spy proof: mounts the REAL Vault Quest
 * admin router (not a mock of the route) and fires N genuinely concurrent, IDENTICAL
 * POSTs (same idempotencyKey + same body) at the single-character generate-artwork
 * route. Asserts the Higgsfield create spy was called EXACTLY ONCE — the literal
 * "true-parallel identical requests → exactly one paid provider execution" proof.
 *
 * Isolated local Postgres only (TEST_DATABASE_URL, pinned/hard-failed); skipped
 * without it. No real R2/provider — Higgsfield is a spy; R2/storage are mocked.
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

// Spy the paid provider create. A small artificial delay widens the concurrency
// window so all N requests genuinely overlap in-flight (proves the race, not just
// "requests happened to be sequential"). Returns a REAL tiny PNG (the route thumbnails
// it with sharp, which rejects a fake byte buffer).
const TINY_PNG = vi.hoisted(() => Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));
const createSpy = vi.hoisted(() => vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 120));
  return { provider: "higgsfield", model: "nano_banana", png: TINY_PNG, width: 512, height: 512, jobId: "job-spy-1" };
}));
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateHiggsfieldArtwork: createSpy, higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "" }) };
});

vi.mock("../server/vault-quest/storage", () => {
  const character = {
    characterId: "GNV-F01-S1", familyId: "GNV-F01", stageNumber: 1, cardId: "GNV-001",
    descriptionStatus: "approved", evolvesFromCharacterId: null, referencePack: null,
    characterName: "Spy Subject", characterDna: "a small spark creature",
  };
  let nextCandidateId = 1;
  return {
    vqStorage: {
      getCharacter: vi.fn(async () => character),
      recordArtworkCandidate: vi.fn(async () => ({ id: nextCandidateId++ })),
      recordAiGeneration: vi.fn(async () => 1),
      setArtworkCandidateIdentity: vi.fn(async () => undefined),
      markArtworkCandidateStatusById: vi.fn(async () => undefined),
    },
  };
});

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

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

run("double-pay protection — true-parallel identical requests hit ONE real route", () => {
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
    // This project's integration suite assumes exclusive DB access per invocation
    // (matching tests/vq-generation-guard.integration.test.ts's own convention) —
    // clear so the shared hourly/daily spend window can't spill across test files.
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("6 concurrent IDENTICAL requests (same idempotencyKey) → exactly ONE provider create call", async () => {
    const idempotencyKey = "spy-shared-key-1";
    const body = { referenceType: "action_pose", model: "nano_banana", idempotencyKey };
    const results = await Promise.all(Array.from({ length: 6 }, () => post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", body)));

    expect(createSpy).toHaveBeenCalledTimes(1); // the headline proof

    const succeeded = results.filter((r) => r.status === 201);
    const pending = results.filter((r) => r.status === 202);
    expect(succeeded.length).toBe(1);
    expect(pending.length).toBe(5);
    for (const p of pending) expect((p.json as { pending?: boolean }).pending).toBe(true);
  });

  it("a DIFFERENT idempotencyKey for the SAME character is an independent request — its own provider call", async () => {
    const first = await post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey: "spy-key-A" });
    const second = await post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey: "spy-key-B" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2); // two distinct deliberate requests — both legitimately charge
  });

  it("REPLAY: resending the SAME key after completion returns the stored result, makes NO new provider call", async () => {
    const idempotencyKey = "spy-replay-key";
    const first = await post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey });
    expect(first.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const replay = await post("/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork", { referenceType: "action_pose", model: "nano_banana", idempotencyKey });
    expect(replay.status).toBe(200);
    expect((replay.json as { replayed?: boolean }).replayed).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1); // still 1 — the replay did not charge again
  });
});
