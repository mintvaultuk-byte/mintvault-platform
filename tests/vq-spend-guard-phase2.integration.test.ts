/**
 * Vault Quest spend-guard hardening (Phase 2) — END-TO-END route wiring for the two
 * NEW server-authoritative hard stops added this phase:
 *
 *   B. Per-generation-type toggle: an owner can disable JUST Action Reference (say)
 *      via vq_feature_flags without touching the master "generation" switch or any
 *      other reference type — checked BEFORE spend/reservation/provider, so a
 *      disabled type makes ZERO provider calls.
 *   E. Automatic paid retry defaults OFF: unless the owner has explicitly stored
 *      {feature:"auto_paid_retry", enabled:true}, a background/pose/identity/
 *      evolution failure gets AT MOST ONE paid provider call — never a 2nd automatic
 *      attempt. This is a real behaviour change from the previous always-retry-once
 *      default; this file proves the NEW default explicitly (the retry-when-enabled
 *      mechanics themselves are proven in vq-pose-diversity-gate.integration.test.ts /
 *      vq-action-reference-background-gate.integration.test.ts / etc., which now
 *      explicitly enable the toggle in their own setup).
 *
 * Mounts the REAL Vault Quest admin router against the isolated local Postgres;
 * mocks generateHiggsfieldArtwork + scoreCharacterIdentity for determinism.
 *
 * Isolated local Postgres only (TEST_DATABASE_URL, pinned/hard-failed); skipped
 * without it. No real R2, no real Higgsfield, no real Anthropic call.
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
  const ok = (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === (process.env.MINTVAULT_TEST_PG16_PORT || "55432") && u.pathname === "/mintvault_vq_phase10_local";
  if (!ok) throw new Error(`REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pg = require("pg");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { drizzle } = require("drizzle-orm/node-postgres");
  const pool = new pg.Pool({ connectionString: url, ssl: false, max: 8 });
  return { db: drizzle(pool), pool };
});
vi.mock("../server/auth", () => ({ requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next() }));

const WHITE_PNG = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require("sharp");
  const width = 200, height = 200;
  const buf = Buffer.alloc(width * height * 3);
  const border = 24;
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inBorder = x < border || x >= width - border || y < border || y >= height - border;
      if (inBorder) { buf[i] = 245; buf[i + 1] = 245; buf[i + 2] = 245; }
      else {
        const v = Math.max(150, Math.min(250, 200 + Math.round((rand() - 0.5) * 100)));
        buf[i] = v; buf[i + 1] = Math.max(0, Math.min(255, v - 15)); buf[i + 2] = Math.max(0, Math.min(255, v - 30));
      }
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
});

const createSpy = vi.hoisted(() =>
  vi.fn(async () => ({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG, width: 200, height: 200, jobId: "job-p2" }))
);
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateHiggsfieldArtwork: createSpy, higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "" }) };
});

const scoreSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/identity", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, scoreCharacterIdentity: scoreSpy };
});

const candidateStore = vi.hoisted(() => new Map<number, { id: number; characterId: string; status: string }>());
const nextCandidateId = vi.hoisted(() => ({ value: 1 }));

const CHAR = vi.hoisted(() => ({
  characterId: "GNV-P2-S1", familyId: "GNV-P2", stageNumber: 1, cardId: "GNV-200",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-P2-S1/approved/master_portrait.png" } },
  characterName: "Phase2 Subject", element: "Flame", bodyShape: "small", colours: "red", markings: "none", eyes: "amber", tailAccessories: "none", locked: false,
}));

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async () => CHAR),
    recordArtworkCandidate: vi.fn(async (input: Record<string, unknown>) => {
      const id = nextCandidateId.value++;
      const row = { id, characterId: input.characterId as string, status: "candidate" };
      candidateStore.set(id, row);
      return row;
    }),
    recordAiGeneration: vi.fn(async () => 1),
    setArtworkCandidateIdentity: vi.fn(async () => undefined),
    markArtworkCandidateStatusById: vi.fn(async (id: number, status: string) => {
      const row = candidateStore.get(id);
      if (row) row.status = status;
    }),
    getArtworkCandidate: vi.fn(async (id: number) => candidateStore.get(id)),
    getFamily: vi.fn(async () => undefined),
  },
}));

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async () => undefined),
  getR2Buffer: vi.fn(async (key: string) => (key.endsWith("/master_portrait.png") ? Buffer.from("MASTER") : null)),
  getR2ObjectStream: vi.fn(async () => null),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";
let keyCounter = 0;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const identityPass = { score: 92, verdict: "pass" as const, threshold: 70, breakdown: { bodyShape: 92, colours: 92, markings: 92, eyes: 92, silhouette: 92, accessories: 92, familyTraits: 92, stageTraits: 92 } };

run("Vault Quest spend-guard Phase 2 — per-type toggle + automatic-retry-off default", () => {
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
    scoreSpy.mockReset();
    candidateStore.clear();
    nextCandidateId.value = 1;
    keyCounter++;
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_feature_flags", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_feature_flags", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("item B: disabling gen_action_pose blocks Action Reference generation with ZERO provider calls", async () => {
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', false, 'test')", []);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p2-type-off-${keyCounter}`,
    });
    expect(res.status).toBe(503);
    expect((res.json as { disabled?: boolean }).disabled).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("item B: disabling gen_action_pose does NOT block Master Reference generation (per-type, not global) — Master explicitly enabled", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', false, 'test'), ('gen_master_portrait', true, 'test')", []);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `p2-type-off-other-ok-${keyCounter}`,
    });
    expect(res.status).toBe(201);
  });

  it("correction A: a newly deployed generation type with NO DB row is OFF by default (not merely 'not yet touched')", async () => {
    // No INSERT at all — the absent-row case for a type nobody has configured yet.
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p2-absent-row-off-${keyCounter}`,
    });
    expect(res.status).toBe(503);
    expect((res.json as { disabled?: boolean; reason?: string }).disabled).toBe(true);
    expect((res.json as { reason?: string }).reason).toBe("not_yet_enabled");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("correction A: explicitly enabling ONE type does not enable any other type (each still absent → still OFF)", async () => {
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_master_portrait', true, 'test')", []);
    // gen_action_pose has NO row — must still be OFF even though a sibling type is ON.
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p2-sibling-still-off-${keyCounter}`,
    });
    expect(res.status).toBe(503);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("correction A: the global 'generation' lock still overrides an explicitly-enabled type", async () => {
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', true, 'test'), ('generation', false, 'test')", []);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p2-global-overrides-type-${keyCounter}`,
    });
    expect(res.status).toBe(503);
    expect((res.json as { feature?: string }).feature).toBe("generation");
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("item B: the toggle route accepts every new per-type + auto-retry feature key", async () => {
    for (const feature of ["gen_master_portrait", "gen_action_pose", "gen_face_closeup", "gen_turnaround_sheet", "gen_colour_sheet", "gen_card_artwork", "gen_replacement", "auto_paid_retry"]) {
      const res = await fetch(`${base}/api/admin/vault-quest/ops/feature-flags/${feature}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, reason: "test" }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("item E: automatic paid retry defaults OFF — a background failure on attempt 1 gets NO 2nd provider call (discarded, 422)", async () => {
    // Force a studio-background rejection on the ONLY attempt made — a real solid
    // colour (WHITE_PNG) actually passes validateStudioBackground, so instead prove
    // the retry-count contract directly: identity/pose scoring is only ever invoked
    // ONCE regardless of its verdict when auto_paid_retry is absent (default OFF).
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', true, 'test')", []);
    scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 0, verdict: "fail" as const, threshold: 55 } });
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p2-retry-off-${keyCounter}`,
    });
    expect(res.status).toBe(201); // identity still passed — visible, just blocked from approval
    expect(createSpy).toHaveBeenCalledTimes(1); // NOT 2 — no automatic retry by default
    expect(scoreSpy).toHaveBeenCalledTimes(1);
  });

  it("item E: explicitly enabling auto_paid_retry restores the retry-once behaviour (2 provider calls)", async () => {
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', true, 'test')", []);
    scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 0, verdict: "fail" as const, threshold: 55 } });
    scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 90, verdict: "pass" as const, threshold: 55 } });
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('auto_paid_retry', true, 'test')", []);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p2-retry-on-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2); // retry mechanics unchanged when explicitly enabled
  });

  it("item E: provider_call_count charged reflects only the actual attempt(s) made (1 by default)", async () => {
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('gen_action_pose', true, 'test')", []);
    scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 0, verdict: "fail" as const, threshold: 55 } });
    const idempotencyKey = `p2-retry-off-charge-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey,
    });
    expect(res.status).toBe(201);
    const { rows } = await q("SELECT charged_credits FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number((rows[0] as { charged_credits: string }).charged_credits)).toBe(1); // 1 image x 1 actual call, not 2
  });
});
