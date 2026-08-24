/**
 * Vault Quest spend-guard Phase 3B — low-cost model policy WIRED into every paid
 * route (single/batch/family/card-artwork), plus batch/family hard job-count
 * limits (item 6A). Mounts the REAL admin router against the isolated local
 * Postgres; mocks generateHiggsfieldArtwork + scoreCharacterIdentity. No real R2,
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
  vi.fn(async (opts: { model?: string }) => ({ provider: "higgsfield" as const, model: opts?.model ?? "z_image", png: await WHITE_PNG, width: 200, height: 200, jobId: "job-p3b-1" }))
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

// A character with NO approved references at all (own pack empty, not evolving).
const CHAR_NOREF = vi.hoisted(() => ({
  characterId: "GNV-P3B-S1", familyId: "GNV-P3B", stageNumber: 1, cardId: "GNV-400",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: {},
  characterName: "P3B NoRef", element: "Flame", bodyShape: "small", colours: "red", markings: "none", eyes: "amber", tailAccessories: "none", locked: false,
}));
// A character WITH an approved master reference (own pack non-empty) — a request
// for it should be upgraded away from z_image (can't carry references).
const CHAR_WITHREF = vi.hoisted(() => ({
  characterId: "GNV-P3B-S2", familyId: "GNV-P3B", stageNumber: 1, cardId: "GNV-401",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-P3B-S2/approved/master_portrait.png" } },
  characterName: "P3B WithRef", element: "Flame", bodyShape: "small", colours: "red", markings: "none", eyes: "amber", tailAccessories: "none", locked: false,
}));

const FAMILY_CHARS = vi.hoisted(() => [
  { characterId: "GNV-P3BF-S1", familyId: "GNV-P3BF", stageNumber: 1, cardId: "GNV-410", descriptionStatus: "approved", evolvesFromCharacterId: null, referencePack: {}, characterName: "F1", element: "Flame", bodyShape: "s", colours: "r", markings: "n", eyes: "a", tailAccessories: "n", locked: false },
  { characterId: "GNV-P3BF-S2", familyId: "GNV-P3BF", stageNumber: 2, cardId: "GNV-411", descriptionStatus: "approved", evolvesFromCharacterId: "GNV-P3BF-S1", referencePack: {}, characterName: "F2", element: "Flame", bodyShape: "s", colours: "r", markings: "n", eyes: "a", tailAccessories: "n", locked: false },
  { characterId: "GNV-P3BF-S3", familyId: "GNV-P3BF", stageNumber: 3, cardId: "GNV-412", descriptionStatus: "approved", evolvesFromCharacterId: "GNV-P3BF-S2", referencePack: {}, characterName: "F3", element: "Flame", bodyShape: "s", colours: "r", markings: "n", eyes: "a", tailAccessories: "n", locked: false },
]);
// A 4th-stage family used ONLY for the over-limit test (never generated for real).
const OVER_LIMIT_FAMILY_ID = "GNV-P3BX";
const OVER_LIMIT_FAMILY_CHARS = vi.hoisted(() =>
  Array.from({ length: 4 }, (_, i) => ({
    characterId: `GNV-P3BX-S${i + 1}`, familyId: "GNV-P3BX", stageNumber: i + 1, cardId: `GNV-42${i}`,
    descriptionStatus: "approved", evolvesFromCharacterId: i > 0 ? `GNV-P3BX-S${i}` : null, referencePack: {},
    characterName: `X${i + 1}`, element: "Flame", bodyShape: "s", colours: "r", markings: "n", eyes: "a", tailAccessories: "n", locked: false,
  }))
);

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async (id: string) => {
      if (id === CHAR_WITHREF.characterId) return CHAR_WITHREF;
      return CHAR_NOREF;
    }),
    getCharacterBibleForCard: vi.fn(async (cardId: string) =>
      cardId === CHAR_WITHREF.cardId ? { character: CHAR_WITHREF, previousCharacter: undefined } : undefined
    ),
    listCharacters: vi.fn(async () => [...FAMILY_CHARS, ...OVER_LIMIT_FAMILY_CHARS]),
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

run("Vault Quest spend-guard Phase 3B — model policy wired + batch/family hard limits", () => {
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
    await q(ENABLE_TYPES, []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_feature_flags", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("1. an unsupported model is rejected before provider contact", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "gpt-image-9000", idempotencyKey: `p3b-badmodel-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("2. nano_banana_pro rejected without confirmation", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana_pro", idempotencyKey: `p3b-premium-noconfirm-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("3. nano_banana_pro rejected without reason", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana_pro", premiumConfirmed: true, idempotencyKey: `p3b-premium-noreason-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("4. whitespace-only reason rejected", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana_pro", premiumConfirmed: true, premiumReason: "   ", idempotencyKey: `p3b-premium-wsreason-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("5. a valid explicit premium override is accepted", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana_pro", premiumConfirmed: true, premiumReason: "hero card, needs the best quality",
      idempotencyKey: `p3b-premium-ok-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect((createSpy.mock.calls[0][0] as { model: string }).model).toBe("nano_banana_pro");
  });

  it("6. a reference-dependent request resolves z_image up to nano_banana", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_WITHREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "z_image", idempotencyKey: `p3b-ref-upgrade-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect((createSpy.mock.calls[0][0] as { model: string }).model).toBe("nano_banana");
  });

  it("7. a no-reference request may use z_image where supported", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "z_image", idempotencyKey: `p3b-noref-cheap-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect((createSpy.mock.calls[0][0] as { model: string }).model).toBe("z_image");
  });

  it("8. cost reservation uses the RESOLVED model's price, not the originally requested one", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    const idempotencyKey = `p3b-reserve-resolved-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_WITHREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "z_image", idempotencyKey, // requested z_image (0.15cr) but will resolve to nano_banana (1cr)
    });
    expect(res.status).toBe(201);
    const { rows } = await q("SELECT max_authorised_spend, model_used FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number((rows[0] as { max_authorised_spend: string }).max_authorised_spend)).toBe(1); // nano_banana price, not z_image's 0.15
    expect((rows[0] as { model_used: string }).model_used).toBe("nano_banana");
  });

  it("9. the persisted model equals the model actually sent to the mocked provider", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    const idempotencyKey = `p3b-persist-match-${keyCounter}`;
    await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey,
    });
    const { rows } = await q("SELECT model_used FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    expect((rows[0] as { model_used: string }).model_used).toBe((createSpy.mock.calls[0][0] as { model: string }).model);
  });

  it("10. no automatic second premium generation occurs — exactly one provider call", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass);
    await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana_pro", premiumConfirmed: true, premiumReason: "test", idempotencyKey: `p3b-premium-once-${keyCounter}`,
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("11. replacement (card artwork, no dedicated policy entry) inherits card_artwork's draft default", async () => {
    const res = await post(`/api/admin/vault-quest/ai/artwork`, {
      context: { cardId: "GNV-REPL-1", name: "Replacement Card", element: "Flame" }, mode: "main", slot: "main",
      idempotencyKey: `p3b-replacement-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect((createSpy.mock.calls[0][0] as { model: string }).model).toBe("z_image"); // card_artwork's draft default
  });

  it("12a. batch generation cannot bypass premium confirmation", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork/batch`, {
      count: 2, referenceType: "action_pose", model: "nano_banana_pro", idempotencyKey: `p3b-batch-premium-noconfirm-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("12b. family generation cannot bypass premium confirmation", async () => {
    const res = await post(`/api/admin/vault-quest/characters/family/GNV-P3BF/generate-artwork`, {
      model: "nano_banana_pro", idempotencyKey: `p3b-family-premium-noconfirm-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  // ── Feature 6A: batch/family hard job-count limits ──────────────────────────
  it("batch: over-limit job count is rejected before any provider call", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork/batch`, {
      count: 10, referenceType: "action_pose", idempotencyKey: `p3b-batch-overlimit-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect((res.json as { maxJobs?: number }).maxJobs).toBe(3);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("batch: an invalid (non-integer/negative) job count is rejected before any provider call", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHAR_NOREF.characterId}/generate-artwork/batch`, {
      count: -1, referenceType: "action_pose", idempotencyKey: `p3b-batch-invalid-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("family: over-limit (>3 stage) family is rejected before any provider call, with zero partial execution", async () => {
    const res = await post(`/api/admin/vault-quest/characters/family/${OVER_LIMIT_FAMILY_ID}/generate-artwork`, {
      idempotencyKey: `p3b-family-overlimit-${keyCounter}`,
    });
    expect(res.status).toBe(400);
    expect((res.json as { maxJobs?: number }).maxJobs).toBe(3);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("family: a normal 3-stage family is NOT blocked by the hard limit", async () => {
    scoreSpy.mockResolvedValue(identityPass);
    const res = await post(`/api/admin/vault-quest/characters/family/GNV-P3BF/generate-artwork`, {
      idempotencyKey: `p3b-family-normal-${keyCounter}`,
    });
    expect(res.status).toBe(201);
  });

  it("each provider job in a family request still requests exactly one image (per-character calls, not a batch payload)", async () => {
    scoreSpy.mockResolvedValue(identityPass);
    await post(`/api/admin/vault-quest/characters/family/GNV-P3BF/generate-artwork`, {
      idempotencyKey: `p3b-family-one-each-${keyCounter}`,
    });
    // 3 characters => at most 3 provider calls (1 each), never a single multi-image request.
    expect(createSpy.mock.calls.length).toBeLessThanOrEqual(3);
    for (const call of createSpy.mock.calls) {
      expect(call[0]).not.toHaveProperty("count");
    }
  });
});
