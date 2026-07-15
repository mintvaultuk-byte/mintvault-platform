/**
 * Vault Quest spend-guard Phase 3A — server-side hardening:
 *   1. One-image-per-request enforcement on the two SINGLE-generation routes.
 *   2. Retry-aware cost reservation — reserve 1× when auto_paid_retry is OFF
 *      (the default) or the type/route has no retry path at all; reserve 2×
 *      ONLY when auto_paid_retry is explicitly ON and the type can retry.
 *   4. provider_job_id persisted on both success and failure-after-create.
 *
 * Mounts the REAL admin router against the isolated local Postgres; mocks
 * generateHiggsfieldArtwork + scoreCharacterIdentity for determinism. No real R2,
 * no real Higgsfield.
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
  vi.fn(async () => ({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG, width: 200, height: 200, jobId: "job-p3a-1" }))
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
  characterId: "GNV-P3-S1", familyId: "GNV-P3", stageNumber: 1, cardId: "GNV-300",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-P3-S1/approved/master_portrait.png" } },
  characterName: "Phase3a Subject", element: "Flame", bodyShape: "small", colours: "red", markings: "none", eyes: "amber", tailAccessories: "none", locked: false,
}));

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async () => CHAR),
    getCharacterBibleForCard: vi.fn(async () => undefined),
    recordArtworkCandidate: vi.fn(async (input: Record<string, unknown>) => {
      const id = nextCandidateId.value++;
      const row = { id, characterId: (input.characterId as string) ?? "card", status: "candidate" };
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
import { HiggsfieldJobError } from "../server/vault-quest/ai/higgsfield";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";
let keyCounter = 0;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const identityPass = { score: 92, verdict: "pass" as const, threshold: 70, breakdown: { bodyShape: 92, colours: 92, markings: 92, eyes: 92, silhouette: 92, accessories: 92, familyTraits: 92, stageTraits: 92 } };

const ENABLE_TYPES =
  "INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES " +
  "('gen_master_portrait',true,'test'),('gen_action_pose',true,'test'),('gen_card_artwork',true,'test') " +
  "ON CONFLICT (feature) DO UPDATE SET enabled = true";

run("Vault Quest spend-guard Phase 3A — one-image enforcement + retry-aware reservation + job-id persistence", () => {
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
    createSpy.mockReset();
    createSpy.mockImplementation(async () => ({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG, width: 200, height: 200, jobId: "job-p3a-1" }));
    scoreSpy.mockReset();
    candidateStore.clear();
    nextCandidateId.value = 1;
    keyCounter++;
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_feature_flags", []);
    await q(ENABLE_TYPES, []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_feature_flags", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  // ── Item 1: one image per request ─────────────────────────────────────────
  describe("one-image-per-request enforcement", () => {
    const invalidCounts = [0, 2, -1, "two", null];
    for (const count of invalidCounts) {
      it(`rejects count=${JSON.stringify(count)} with zero provider calls`, async () => {
        const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
          referenceType: "action_pose", model: "nano_banana", count, idempotencyKey: `p3a-count-${JSON.stringify(count)}-${keyCounter}`,
        });
        expect(res.status).toBe(400);
        expect(createSpy).not.toHaveBeenCalled();
      });
    }
    it("count=1 is accepted (explicit, matches the implicit default)", async () => {
      scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 90, verdict: "pass" as const, threshold: 55 } });
      const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", count: 1, idempotencyKey: `p3a-count-1-${keyCounter}`,
      });
      expect(res.status).toBe(201);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
    it("missing count normalizes to 1 (no behaviour change for the existing client)", async () => {
      scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 90, verdict: "pass" as const, threshold: 55 } });
      const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p3a-count-missing-${keyCounter}`,
      });
      expect(res.status).toBe(201);
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Item 2: retry-aware reservation ───────────────────────────────────────
  describe("retry-aware cost reservation", () => {
    it("auto_paid_retry OFF (default): a retry-capable type (action_pose) reserves 1×, not 2×", async () => {
      scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 90, verdict: "pass" as const, threshold: 55 } });
      const idempotencyKey = `p3a-reserve-1x-${keyCounter}`;
      const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", idempotencyKey,
      });
      expect(res.status).toBe(201);
      const { rows } = await q("SELECT max_authorised_spend FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
      expect(Number((rows[0] as { max_authorised_spend: string }).max_authorised_spend)).toBe(1);
    });

    it("auto_paid_retry explicitly ON: the same retry-capable type reserves up to 2×", async () => {
      await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('auto_paid_retry', true, 'test')", []);
      scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 90, verdict: "pass" as const, threshold: 55 } });
      const idempotencyKey = `p3a-reserve-2x-${keyCounter}`;
      const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", idempotencyKey,
      });
      expect(res.status).toBe(201);
      const { rows } = await q("SELECT max_authorised_spend FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
      expect(Number((rows[0] as { max_authorised_spend: string }).max_authorised_spend)).toBe(2);
    });

    it("card artwork ALWAYS reserves 1× — it has no internal retry loop regardless of auto_paid_retry", async () => {
      await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('auto_paid_retry', true, 'test')", []);
      const idempotencyKey = `p3a-card-1x-${keyCounter}`;
      const res = await post(`/api/admin/vault-quest/ai/artwork`, {
        context: { cardId: "GNV-300-CARD", name: "Phase3a Card", element: "Flame" },
        mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      });
      expect(res.status).toBe(201);
      expect(createSpy).toHaveBeenCalledTimes(1); // no internal retry loop exists for this route
      const { rows } = await q("SELECT max_authorised_spend, charged_credits FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
      expect(Number((rows[0] as { max_authorised_spend: string }).max_authorised_spend)).toBe(1);
      expect(Number((rows[0] as { charged_credits: string }).charged_credits)).toBe(1);
    });
  });

  // ── Item 4: provider job id persistence ────────────────────────────────────
  describe("provider job id persistence", () => {
    it("a successful generation persists provider_job_id", async () => {
      scoreSpy.mockResolvedValueOnce({ ...identityPass, poseDiversity: { difference: 90, verdict: "pass" as const, threshold: 55 } });
      const idempotencyKey = `p3a-jobid-success-${keyCounter}`;
      const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", idempotencyKey,
      });
      expect(res.status).toBe(201);
      const { rows } = await q("SELECT provider_job_id FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
      expect((rows[0] as { provider_job_id: string }).provider_job_id).toBe("job-p3a-1");
    });

    it("a failure AFTER the provider job was created (poll failure) still persists provider_job_id", async () => {
      createSpy.mockRejectedValueOnce(new HiggsfieldJobError("Higgsfield poll failed (500): gateway error", "job-failed-after-create"));
      const idempotencyKey = `p3a-jobid-failure-${keyCounter}`;
      const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", idempotencyKey,
      });
      expect(res.status).toBe(500); // uncaught thrown error → route's generic catch
      const { rows } = await q("SELECT provider_job_id, state FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
      expect((rows[0] as { provider_job_id: string }).provider_job_id).toBe("job-failed-after-create");
      expect((rows[0] as { state: string }).state).toBe("unknown_provider_state");
    });

    it("provider_job_id is never read to trigger a second provider call — no automatic retry occurs on failure", async () => {
      createSpy.mockRejectedValueOnce(new HiggsfieldJobError("Higgsfield generation failed", "job-no-retry"));
      await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
        referenceType: "action_pose", model: "nano_banana", idempotencyKey: `p3a-jobid-noretry-${keyCounter}`,
      });
      expect(createSpy).toHaveBeenCalledTimes(1); // exactly the one failed attempt, never a 2nd
    });
  });
});
