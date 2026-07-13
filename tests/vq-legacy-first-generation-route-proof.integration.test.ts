/**
 * Legacy Higgsfield First-Generation Activation — Stage 3 non-spending route proof.
 *
 * Mounts the REAL Vault Quest admin router and drives the REAL
 * POST /api/admin/vault-quest/ai/artwork route (the "Main" button under the
 * AiAssist panel's Artwork tab) end to end, with Higgsfield itself mocked (a spy,
 * never a real network call) so this proves the wiring without spending a credit.
 *
 * Proves, all in one pass:
 *   - the route is reached and returns 201 with provider "higgsfield"
 *   - a REAL vq_generation_requests row is reserved (Phase 10A D10 idempotency)
 *     and finalized to state=completed with the correct charged credits/model
 *   - the spend gate approves a 1-credit nano_banana request (well under the
 *     8cr/request conservative default ceiling)
 *   - the provider payload is correctly formed: prompt, mode, slot, model
 *   - reference images ARE attached when the card's linked character has an
 *     approved reference pack (identity-lock), and are NOT attached when it
 *     doesn't (both branches proven)
 *   - the R2 candidate key handed to uploadToR2 passes the REAL (unmocked)
 *     assertVqWriteKey guard
 *   - a repeated identical request (same idempotency key) makes NO second
 *     provider call — it replays the stored result instead
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

// A real (tiny, valid) PNG — the route thumbnails/reads it with sharp, which
// rejects a fake byte buffer. Used both as the "generated" result and as the
// mocked reference-image bytes read back from R2.
const TINY_PNG = vi.hoisted(() => Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

// Spy the ONLY generation entry point the card-art route calls. This IS the
// Legacy path (server/vault-quest/ai/higgsfield.ts) — there is no Cloud client
// anywhere in this call chain (structurally confirmed separately: no
// @higgsfield/client import in any source file, not in package.json).
const createSpy = vi.hoisted(() => vi.fn(async (opts: { prompt: string; mode: string; slot: string; model?: string; imageReferences?: Buffer[] }) => ({
  provider: "higgsfield" as const,
  model: opts.model || "nano_banana",
  png: TINY_PNG,
  width: 512,
  height: 512,
  jobId: "job-stage3-proof",
})));
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateHiggsfieldArtwork: createSpy, higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "API key configured · model nano_banana", baseUrl: "https://fnf-api-gw.higgsfield.ai/fnf" }) };
});

// Text prompt generation (Anthropic) is a SEPARATE provider from the image path —
// force it unavailable so the route deterministically falls back to the safe
// rule-based prompt builder, with zero real network calls in this proof.
vi.mock("../server/vault-quest/ai/generators", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runGenerator: vi.fn(async () => { throw new Error("text provider unavailable in this proof"); }) };
});

// Identity scoring also calls Anthropic vision — mock a clean pass so this proof
// never depends on real network access, and isn't gated on scoring.
vi.mock("../server/vault-quest/ai/identity", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    scoreCharacterIdentity: vi.fn(async () => ({
      score: 92, verdict: "pass", threshold: 70,
      breakdown: { bodyShape: 90, colours: 90, markings: 90, eyes: 90, silhouette: 90, accessories: 90, familyTraits: 90, stageTraits: 90 },
    })),
  };
});

const uploadSpy = vi.hoisted(() => vi.fn(async () => undefined));
const r2Store = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../server/r2", () => ({
  uploadToR2: uploadSpy,
  getR2Buffer: vi.fn(async (key: string) => r2Store.get(key) ?? null),
  getR2ObjectStream: vi.fn(async () => null),
}));

const WITH_REFS_CARD = {
  cardId: "T-STAGE3-REF", collectorNumber: "901/999", name: "Stage3 Ref Card", displayName: null,
  cardType: "Creature", element: "Flame", rarity: null, familyId: "T-FAM-1", stageNumber: 1,
  baseCardId: null, variantTier: null, setCode: "GNV",
};
const NO_REFS_CARD = {
  cardId: "T-STAGE3-NOREF", collectorNumber: "902/999", name: "Stage3 No-Ref Card", displayName: null,
  cardType: "Creature", element: "Flame", rarity: null, familyId: "T-FAM-2", stageNumber: 1,
  baseCardId: null, variantTier: null, setCode: "GNV",
};
const CHARACTER_WITH_REFS = {
  characterId: "T-STAGE3-CHAR", familyId: "T-FAM-1", stageNumber: 1, cardId: "T-STAGE3-REF",
  descriptionStatus: "approved", evolvesFromCharacterId: null, characterName: "Stage3 Test Subject",
  element: "Flame", familyName: null, characterDna: "a small ember creature", visualDescription: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/T-STAGE3-CHAR/approved/master_portrait/x.png" } },
};
const CHARACTER_NO_REFS = {
  characterId: "T-STAGE3-CHAR2", familyId: "T-FAM-2", stageNumber: 1, cardId: "T-STAGE3-NOREF",
  descriptionStatus: "approved", evolvesFromCharacterId: null, characterName: "Stage3 No-Ref Subject",
  element: "Flame", familyName: null, characterDna: "a small ember creature", visualDescription: null,
  referencePack: null,
};

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCard: vi.fn(async (cardId: string) => {
      if (cardId === WITH_REFS_CARD.cardId) return WITH_REFS_CARD;
      if (cardId === NO_REFS_CARD.cardId) return NO_REFS_CARD;
      return undefined;
    }),
    getCharacterByBaseCardId: vi.fn(async (cardId: string) => {
      if (cardId === WITH_REFS_CARD.cardId) return CHARACTER_WITH_REFS;
      if (cardId === NO_REFS_CARD.cardId) return CHARACTER_NO_REFS;
      return undefined;
    }),
    getFamily: vi.fn(async () => undefined),
    getCharacterBibleForCard: vi.fn(async (cardId: string) => {
      const card = cardId === WITH_REFS_CARD.cardId ? WITH_REFS_CARD : cardId === NO_REFS_CARD.cardId ? NO_REFS_CARD : undefined;
      if (!card) return undefined;
      const character = cardId === WITH_REFS_CARD.cardId ? CHARACTER_WITH_REFS : CHARACTER_NO_REFS;
      return { card, baseCard: null, character, previousCharacter: null, family: undefined };
    }),
    recordArtworkCandidate: vi.fn(async (input: { id?: number }) => ({ id: 1, ...input })),
    recordAiGeneration: vi.fn(async () => 1),
    setArtworkCandidateIdentity: vi.fn(async () => undefined),
    markArtworkCandidateStatusById: vi.fn(async () => undefined),
  },
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { assertVqWriteKey } from "../server/vault-quest/lib/vq-keys";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

run("Legacy first-generation — non-spending route proof (Stage 3)", () => {
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
    uploadSpy.mockClear();
    r2Store.clear();
    r2Store.set("vq/characters/T-STAGE3-CHAR/approved/master_portrait/x.png", TINY_PNG);
    await q("DELETE FROM vq_generation_requests WHERE card_id LIKE 'T-STAGE3-%'", []);
    await q("DELETE FROM vq_config", []);
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests WHERE card_id LIKE 'T-STAGE3-%'", []);
    await q("DELETE FROM vq_config", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("reaches the route, calls Legacy (not Cloud), and returns 201 with the requested model", async () => {
    const idempotencyKey = "stage3-proof-key-1";
    const res = await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element },
    });
    expect(res.status).toBe(201);
    const body = res.json as { provider: string; model: string; candidateKey: string };
    expect(body.provider).toBe("higgsfield");
    expect(body.model).toBe("nano_banana");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("D10 idempotency: a REAL vq_generation_requests row is reserved and finalized correctly", async () => {
    const idempotencyKey = "stage3-proof-key-2";
    const res = await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element },
    });
    expect(res.status).toBe(201);
    const { rows } = await q(
      "SELECT state, charged_credits, model_used, max_authorised_spend, estimated_credits, generation_type, card_id FROM vq_generation_requests WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(rows.length).toBe(1);
    const row = rows[0] as Record<string, string>;
    expect(row.state).toBe("completed");
    expect(Number(row.charged_credits)).toBe(1); // nano_banana = 1cr/image
    expect(row.model_used).toBe("nano_banana");
    expect(row.generation_type).toBe("card-artwork");
    expect(row.card_id).toBe(WITH_REFS_CARD.cardId);
  });

  it("spend gate: a 1-credit nano_banana request is approved well under the 8cr/request conservative ceiling", async () => {
    const idempotencyKey = "stage3-proof-key-3";
    const res = await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element },
    });
    expect(res.status).toBe(201); // not 402/429 — the gate approved it
    const { rows } = await q("SELECT max_authorised_spend FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number((rows[0] as Record<string, string>).max_authorised_spend)).toBe(1);
  });

  it("provider payload is correctly formed: prompt, mode, slot, model all present", async () => {
    const idempotencyKey = "stage3-proof-key-4";
    await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element },
    });
    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = createSpy.mock.calls[0][0] as { prompt: string; mode: string; slot: string; model?: string };
    expect(typeof call.prompt).toBe("string");
    expect(call.prompt.length).toBeGreaterThan(0);
    expect(call.mode).toBe("main");
    expect(call.slot).toBe("main");
    expect(call.model).toBe("nano_banana");
  });

  it("REFERENCE IMAGES REQUIRED: a card linked to a character with an approved reference pack attaches it (identity lock)", async () => {
    const idempotencyKey = "stage3-proof-key-5";
    await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element },
    });
    const call = createSpy.mock.calls[0][0] as { imageReferences?: Buffer[]; prompt: string };
    expect(call.imageReferences?.length).toBe(1);
    expect(call.imageReferences?.[0]).toBeInstanceOf(Buffer);
    expect(call.prompt).toMatch(/permanent locked visual identity/i); // IDENTITY_LOCK_PROMPT
  });

  it("REFERENCE IMAGES NOT REQUIRED: a card with no linked character/reference pack generates without them", async () => {
    const idempotencyKey = "stage3-proof-key-6";
    const res = await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: NO_REFS_CARD.cardId, name: NO_REFS_CARD.name, element: NO_REFS_CARD.element },
    });
    expect(res.status).toBe(201);
    const call = createSpy.mock.calls[0][0] as { imageReferences?: Buffer[] };
    expect(call.imageReferences).toBeUndefined();
  });

  it("R2 WRITE KEY: the candidate key handed to uploadToR2 passes the REAL assertVqWriteKey guard", async () => {
    const idempotencyKey = "stage3-proof-key-7";
    const res = await post("/api/admin/vault-quest/ai/artwork", {
      mode: "main", slot: "main", model: "nano_banana", idempotencyKey,
      context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element },
    });
    expect(res.status).toBe(201);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const key = uploadSpy.mock.calls[0][0] as string;
    expect(key).toMatch(/^vq\/art-candidates\/T-STAGE3-REF\//);
    expect(() => assertVqWriteKey(key)).not.toThrow(); // the REAL guard, not mocked
    expect((res.json as { candidateKey: string }).candidateKey).toBe(key);
  });

  it("NO DOUBLE-CHARGE: repeating the SAME idempotency key makes NO second provider call", async () => {
    const idempotencyKey = "stage3-proof-key-8";
    const body = { mode: "main", slot: "main", model: "nano_banana", idempotencyKey, context: { cardId: WITH_REFS_CARD.cardId, name: WITH_REFS_CARD.name, element: WITH_REFS_CARD.element } };
    const first = await post("/api/admin/vault-quest/ai/artwork", body);
    expect(first.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const second = await post("/api/admin/vault-quest/ai/artwork", body);
    expect(createSpy).toHaveBeenCalledTimes(1); // still 1 — no second real call
    expect(second.status).not.toBe(201); // replayed or pending, never a fresh 201
  });
});
