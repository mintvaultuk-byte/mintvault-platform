/**
 * Stage 2/3 Evolution Difference gate — END-TO-END route wiring. Mounts the REAL
 * Vault Quest admin router and mocks the Higgsfield create + scoreCharacterIdentity +
 * scoreEvolutionDifference calls so background/identity/evolution verdicts are fully
 * controlled and deterministic per attempt.
 *
 * IMPORTANT: a Master Reference request ALWAYS produces MASTER_CANDIDATE_COUNT (2)
 * candidates (the single-generate route loops `generateCharacterCandidate` that many
 * times server-side — see the existing `isMaster` branch). Every provider-call/
 * candidate-count assertion below is a multiple of that loop, not a single-candidate count.
 *
 * Root cause this fixes: Stage 2/3 Master Reference generation had NO check that the
 * new stage actually looks like a genuine evolution of the previous one — only a
 * soft, unscored text nudge. A near-duplicate of the previous stage (same body, same
 * silhouette, only a minor appendage/accessory change) sailed straight through.
 *
 * Proves:
 *   - identical Stage 1/Stage 2 forms fail the gate
 *   - minor-appendage-only changes fail
 *   - simple enlargement without structural development fails
 *   - a clearly matured Stage 2 passes; a clearly developed Stage 3 passes (stricter threshold)
 *   - identity can PASS while evolution-difference FAILS, and vice versa (independent)
 *   - retry is capped at one per candidate (2 provider calls per candidate, never a 3rd)
 *   - a persistently-failing candidate stays visible but cannot be approved (server-side block)
 *   - Stage 1 generation is completely unaffected (no evolution gate ever activates)
 *   - Action Reference pose-diversity logic is unaffected (mutually exclusive by referenceType)
 *   - the spend estimate correctly prices the worst-case 2x-per-image for a Master Reference
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

// A real solid-white 200x200 PNG — clears the REAL (unmocked) validateStudioBackground,
// used both as the generated candidate (so the background gate never interferes with
// isolating the evolution-difference gate) and as every approved reference image.
const WHITE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACD0lEQVR4nO3UMQ0AAAzDsPEnvaHIMckG0CvqLASmGAVhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYSEs/vBYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSExRYOwsoGniuviZgAAAAASUVORK5CYII=",
  "base64",
);

const createSpy = vi.hoisted(() => vi.fn(async () => ({
  provider: "higgsfield" as const, model: "nano_banana", png: WHITE_PNG, width: 200, height: 200, jobId: "job-evo-gate",
})));
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, generateHiggsfieldArtwork: createSpy, higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "" }) };
});

const scoreSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/identity", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, scoreCharacterIdentity: scoreSpy };
});

const evoScoreSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/evolution-diversity", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, scoreEvolutionDifference: evoScoreSpy };
});

const candidateStore = vi.hoisted(() => new Map<number, { id: number; characterId: string; status: string; identityBreakdown: unknown; r2Key: string }>());
const nextCandidateId = vi.hoisted(() => ({ value: 1 }));

// Stage 1 — already has its OWN approved master (realistic; also serves as the
// "previous stage" reference for the Stage 2 fixtures below).
const STAGE1 = vi.hoisted(() => ({
  characterId: "GNV-EVO-S1", familyId: "GNV-EVO", stageNumber: 1, cardId: "GNV-EVO-001",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-EVO-S1/approved/master_portrait.png" } },
  characterName: "Embergrub", element: "Flame", bodyShape: "small round grub", colours: "red/orange", markings: "flame tip tail", eyes: "amber", tailAccessories: "none",
  locked: false,
}));
// Stage 2 bootstrap — evolves from Stage 1, has NO own reference yet.
const STAGE2_BOOT = vi.hoisted(() => ({
  characterId: "GNV-EVO-S2A", familyId: "GNV-EVO", stageNumber: 2, cardId: "GNV-EVO-002",
  descriptionStatus: "approved", evolvesFromCharacterId: "GNV-EVO-S1",
  referencePack: null,
  characterName: "Embercub", element: "Flame", bodyShape: "lean quadrupedal", colours: "red/orange", markings: "flame mane", eyes: "amber", tailAccessories: "fire tail",
  locked: false,
}));
// Stage 2, but already has its OWN approved (possibly under-evolved) master — the
// exact "Replace Master" scenario from the bug report.
const STAGE2_OWN = vi.hoisted(() => ({
  characterId: "GNV-EVO-S2B", familyId: "GNV-EVO", stageNumber: 2, cardId: "GNV-EVO-003",
  descriptionStatus: "approved", evolvesFromCharacterId: "GNV-EVO-S1",
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-EVO-S2B/approved/master_portrait.png" } },
  characterName: "Embercub", element: "Flame", bodyShape: "lean quadrupedal", colours: "red/orange", markings: "flame mane", eyes: "amber", tailAccessories: "fire tail",
  locked: false,
}));
// Stage 3 bootstrap — evolves from Stage 2 (STAGE2_OWN).
const STAGE3 = vi.hoisted(() => ({
  characterId: "GNV-EVO-S3", familyId: "GNV-EVO", stageNumber: 3, cardId: "GNV-EVO-004",
  descriptionStatus: "approved", evolvesFromCharacterId: "GNV-EVO-S2B",
  referencePack: null,
  characterName: "Emberlord", element: "Flame", bodyShape: "massive biped", colours: "red/orange", markings: "flame crest", eyes: "amber", tailAccessories: "fire tail",
  locked: false,
}));

const BY_ID = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async (characterId: string) => BY_ID.get(characterId)),
    recordArtworkCandidate: vi.fn(async (input: Record<string, unknown>) => {
      const id = nextCandidateId.value++;
      const row = { id, characterId: input.characterId as string, status: "candidate", identityBreakdown: null, r2Key: input.r2Key as string };
      candidateStore.set(id, row);
      return row;
    }),
    recordAiGeneration: vi.fn(async () => 1),
    setArtworkCandidateIdentity: vi.fn(async (id: number, _score: number | null, breakdown: unknown) => {
      const row = candidateStore.get(id);
      if (row) row.identityBreakdown = breakdown;
    }),
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
  getR2Buffer: vi.fn(async (key: string) => {
    const known = [STAGE1.referencePack.master_portrait.r2Key, STAGE2_OWN.referencePack.master_portrait.r2Key];
    return known.includes(key) ? WHITE_PNG : null;
  }),
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

const identityPass = (overrides: Record<string, unknown> = {}) => ({
  score: 90, verdict: "pass" as const, threshold: 70,
  breakdown: { bodyShape: 90, colours: 92, markings: 88, eyes: 91, silhouette: 85, accessories: 89, familyTraits: 90, stageTraits: 90 },
  ...overrides,
});
const identityReject = (overrides: Record<string, unknown> = {}) => ({
  score: 40, verdict: "reject" as const, threshold: 70,
  breakdown: { bodyShape: 40, colours: 35, markings: 30, eyes: 45, silhouette: 40, accessories: 50, familyTraits: 40, stageTraits: 45 },
  ...overrides,
});
const evoFail = (difference = 15, stageNumber = 2) => ({ difference, verdict: "fail" as const, threshold: stageNumber >= 3 ? 60 : 55, stageNumber });
const evoPass = (difference = 78, stageNumber = 2) => ({ difference, verdict: "pass" as const, threshold: stageNumber >= 3 ? 60 : 55, stageNumber });

run("Evolution Difference gate — route wiring", () => {
  beforeAll(async () => {
    BY_ID.set(STAGE1.characterId, STAGE1);
    BY_ID.set(STAGE2_BOOT.characterId, STAGE2_BOOT);
    BY_ID.set(STAGE2_OWN.characterId, STAGE2_OWN);
    BY_ID.set(STAGE3.characterId, STAGE3);
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
    createSpy.mockResolvedValue({ provider: "higgsfield" as const, model: "nano_banana", png: WHITE_PNG, width: 200, height: 200, jobId: "job-evo-gate" });
    scoreSpy.mockReset();
    evoScoreSpy.mockReset();
    candidateStore.clear();
    nextCandidateId.value = 1;
    keyCounter++;
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("DELETE FROM vq_feature_flags WHERE feature = 'auto_paid_retry'", []);
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('auto_paid_retry', true, 'test') ON CONFLICT (feature) DO UPDATE SET enabled = true", []); // item E: these tests exercise the EXISTING retry-on-failure mechanics, which now require the toggle explicitly ON
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("identical Stage 1/Stage 2 form fails on every attempt — stays visible (both candidates), blocked from approval", async () => {
    evoScoreSpy.mockResolvedValue(evoFail(5, 2)); // fails every call, for every candidate
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-identical-${keyCounter}` });
    expect(res.status).toBe(201);
    const body = res.json as { created: { candidateId: number }[]; autoRejected: number; bgRejected: number };
    expect(body.created.length).toBe(2); // NOT hard-discarded — mirrors pose-diversity precedent, stays visible
    expect(body.autoRejected).toBe(0);
    expect(createSpy).toHaveBeenCalledTimes(4); // 2 candidates x 2 attempts each (capped, never a 3rd per candidate)
    expect(evoScoreSpy).toHaveBeenCalledTimes(4);
    for (const c of body.created) expect(candidateStore.get(c.candidateId)?.status).toBe("candidate");

    const approve = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/approve-candidate`, { candidateId: body.created[0].candidateId });
    expect(approve.status).toBe(422);
    expect((approve.json as { error: string }).error).toMatch(/Evolution Difference: Fail/i);
  });

  it("minor appendage/fin-only change fails — the exact bug report symptom", async () => {
    evoScoreSpy.mockResolvedValue(evoFail(20, 2));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-appendage-${keyCounter}` });
    const body = res.json as { created: { candidateId: number }[] };
    const stored = candidateStore.get(body.created[0].candidateId);
    expect((stored?.identityBreakdown as { evolutionDifference?: { verdict: string } })?.evolutionDifference?.verdict).toBe("fail");
  });

  it("simple enlargement without structural development fails", async () => {
    evoScoreSpy.mockResolvedValue(evoFail(35, 2));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-enlarge-${keyCounter}` });
    const body = res.json as { created: { candidateId: number }[] };
    const stored = candidateStore.get(body.created[0].candidateId);
    expect((stored?.identityBreakdown as { evolutionDifference?: { verdict: string } })?.evolutionDifference?.verdict).toBe("fail");
  });

  it("a clearly matured Stage 2 passes immediately — 1 provider call per candidate (2 total), no wasted retries", async () => {
    evoScoreSpy.mockResolvedValue(evoPass(78, 2));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-matured-${keyCounter}` });
    expect(res.status).toBe(201);
    const body = res.json as { created: unknown[] };
    expect(body.created.length).toBe(2);
    expect(createSpy).toHaveBeenCalledTimes(2); // 1 per candidate — no retries needed
    expect(evoScoreSpy).toHaveBeenCalledTimes(2);
  });

  it("a clearly developed Stage 3 passes against its stricter (60) threshold", async () => {
    evoScoreSpy.mockResolvedValue(evoPass(82, 3));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE3.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-stage3-${keyCounter}` });
    expect(res.status).toBe(201);
    expect((res.json as { created: unknown[] }).created.length).toBe(2);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(evoScoreSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ stageNumber: 3 }));
  });

  it("identity PASSES while evolution-difference FAILS — independent gates (own-reference path, combined vision call)", async () => {
    scoreSpy.mockResolvedValue(identityPass({ evolutionDifference: evoFail(20, 2) }));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_OWN.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-id-pass-evo-fail-${keyCounter}` });
    expect(res.status).toBe(201);
    const body = res.json as { created: { candidateId: number }[]; autoRejected: number };
    expect(body.autoRejected).toBe(0); // identity passed every time — stays visible, not auto_rejected
    expect(body.created.length).toBe(2);
    expect(createSpy).toHaveBeenCalledTimes(4); // capped at 2 attempts per candidate

    const approve = await post(`/api/admin/vault-quest/characters/${STAGE2_OWN.characterId}/approve-candidate`, { candidateId: body.created[0].candidateId });
    expect(approve.status).toBe(422);
    expect((approve.json as { error: string }).error).toMatch(/Evolution Difference: Fail/i);
  });

  it("evolution-difference PASSES while identity FAILS — existing identity gate unaffected: still auto-rejected and hidden", async () => {
    scoreSpy.mockResolvedValue(identityReject({ evolutionDifference: evoPass(85, 2) }));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_OWN.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-id-fail-evo-pass-${keyCounter}` });
    expect(res.status).toBe(201); // master route always 201, even if every candidate auto-rejects
    const body = res.json as { created: unknown[]; autoRejected: number };
    expect(body.autoRejected).toBe(2); // identity failed every time — hidden, matching existing behaviour
    expect(body.created.length).toBe(0);
    expect(createSpy).toHaveBeenCalledTimes(2); // evolution passed immediately each time — no retry triggered by the identity result
  });

  it("retry is capped at ONE per candidate (2 provider calls each) even when evolution-difference fails every time", async () => {
    evoScoreSpy.mockResolvedValue(evoFail(10, 2));
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `evo-retry-cap-${keyCounter}` });
    expect(createSpy).toHaveBeenCalledTimes(4); // 2 candidates x 2 attempts, never x3
    expect(evoScoreSpy).toHaveBeenCalledTimes(4);
    expect(res.status).toBe(201); // every candidate accepted regardless (visible-but-blocked), never a 3rd try
  });

  it("Stage 1 generation is completely unchanged — no evolution gate, no evolution scoring call at all", async () => {
    scoreSpy.mockResolvedValue(identityPass());
    const res = await post(`/api/admin/vault-quest/characters/${STAGE1.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `stage1-unaffected-${keyCounter}` });
    expect(res.status).toBe(201);
    const body = res.json as { created: unknown[]; bgRejected: number };
    expect(body.created.length).toBe(2); // Master always makes 2 (founder decision) — unaffected by the evolution gate
    expect(body.bgRejected).toBe(0);
    expect(evoScoreSpy).not.toHaveBeenCalled();
    for (const call of scoreSpy.mock.calls) {
      const opts = call[3] as { evolutionPrevPng?: Buffer } | undefined;
      expect(opts?.evolutionPrevPng).toBeUndefined();
    }
  });

  it("Action Reference (pose-diversity) generation for a stage>1 character never triggers the evolution gate — mutually exclusive by referenceType", async () => {
    // STAGE2_OWN has its own approved master, so action_pose is pose-gated (existing,
    // unrelated logic) — the evolution gate must simply never engage here.
    scoreSpy.mockResolvedValueOnce({ score: 88, verdict: "pass", threshold: 70, breakdown: { bodyShape: 88, colours: 88, markings: 88, eyes: 88, silhouette: 88, accessories: 88, familyTraits: 88, stageTraits: 88 }, poseDiversity: { verdict: "pass", difference: 80, threshold: 55 } });
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_OWN.characterId}/generate-artwork`, { referenceType: "action_pose", model: "nano_banana", idempotencyKey: `evo-action-pose-unaffected-${keyCounter}` });
    expect(res.status).toBe(201);
    expect(evoScoreSpy).not.toHaveBeenCalled();
    for (const call of scoreSpy.mock.calls) {
      const opts = call[3] as { evolutionPrevPng?: Buffer } | undefined;
      expect(opts?.evolutionPrevPng).toBeUndefined();
    }
  });

  it("SPEND ESTIMATE prices the WORST CASE (2x per image) for a Master Reference request (2 images, founder decision), but the ACTUAL charge reflects only what really happened", async () => {
    evoScoreSpy.mockResolvedValue(evoPass(80, 2)); // passes first try every time — only 1 real call per candidate
    const idempotencyKey = `evo-spend-estimate-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/${STAGE2_BOOT.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2); // 2 candidates, no retries

    const { rows } = await q("SELECT max_authorised_spend, charged_credits FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    // 2 requested images x 2 credits worst-case each = 4 (previously under-priced at 2,
    // since Master's own background-retry possibility was never reflected before the
    // earlier fix — see generationCanRetry).
    expect(Number(rows[0].max_authorised_spend)).toBe(4);
    expect(Number(rows[0].charged_credits)).toBe(2); // but only actually charged for the 2 real calls that happened
  });

  it("Master Reference now produces exactly TWO candidates (founder decision, was 3)", async () => {
    scoreSpy.mockResolvedValue(identityPass());
    const res = await post(`/api/admin/vault-quest/characters/${STAGE1.characterId}/generate-artwork`, { referenceType: "master_portrait", model: "nano_banana", idempotencyKey: `master-two-candidates-${keyCounter}` });
    expect(res.status).toBe(201);
    expect((res.json as { created: unknown[]; count: number }).created.length).toBe(2);
    expect((res.json as { count: number }).count).toBe(2);
  });
});
