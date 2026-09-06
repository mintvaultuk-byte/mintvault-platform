/**
 * Action Reference IDENTITY-DRIFT gate — END-TO-END route wiring. Mounts the REAL
 * Vault Quest admin router and mocks generateHiggsfieldArtwork + scoreCharacterIdentity
 * so each attempt is deterministic. Regression proof for the founder-reported bug: a
 * candidate scored an overall 75 ("Needs Review") with Markings: Fail and Style: Fail,
 * yet the OLD single-averaged-score gate still allowed "Approve Action Pose".
 *
 * Proves:
 *   - overall-above-threshold-but-Markings-Fail blocks approval (422).
 *   - overall-above-threshold-but-Style-Fail blocks approval (422).
 *   - an overall "Needs Review" verdict blocks approval even with clean traits (422).
 *   - all critical traits pass + pose passes → NOT blocked by the identity gate.
 *   - a first-attempt identity-drift candidate triggers exactly ONE retry, and the
 *     retry RETAINS the same action category (no pose/novelty failure occurred).
 *   - a second attempt that STILL drifts stays visible (not auto-rejected/hidden) and
 *     remains blocked from approval.
 *   - retry is capped at 2 total provider calls even when only identity (not pose) drifts.
 *   - the pre-flight spend estimate still prices the worst case (2 calls).
 *   - ROOT CAUSE #2 fix: generating an Action Reference for a stage>1 character does
 *     NOT pull the PREVIOUS evolution stage's Master/Colour-Sheet images in as extra
 *     provider references — only the character's OWN pack.
 *
 * Isolated local Postgres only (TEST_DATABASE_URL, pinned/hard-failed); skipped without it.
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

// A real solid off-white 200x200 PNG — every generated candidate must clear the REAL
// (unmocked) validateStudioBackground before the identity/pose gate is reached.
const WHITE_PNG_P = vi.hoisted(() => {
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
const MASTER_BUF = vi.hoisted(() => Buffer.from("MASTER-REFERENCE-IMAGE-BYTES"));
const PREV_MASTER_BUF = vi.hoisted(() => Buffer.from("PREV-STAGE-MASTER-IMAGE-BYTES"));
const PREV_COLOUR_BUF = vi.hoisted(() => Buffer.from("PREV-STAGE-COLOUR-SHEET-IMAGE-BYTES"));

const createSpy = vi.hoisted(() =>
  vi.fn(async () => ({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG_P, width: 200, height: 200, jobId: "job-drift" }))
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

const candidateStore = vi.hoisted(
  () => new Map<number, { id: number; characterId: string; status: string; identityScore: number | null; identityBreakdown: unknown; r2Key: string; referenceType: string }>()
);
const nextCandidateId = vi.hoisted(() => ({ value: 1 }));

// Stage-2 character that EVOLVES FROM a stage-1 character with its own approved
// Master + Colour Sheet — proves RC2 (previous-stage images excluded from Action refs).
const PREV_CHAR = vi.hoisted(() => ({
  characterId: "GNV-F03-S1", familyId: "GNV-F03", stageNumber: 1, cardId: "GNV-090",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: {
    master_portrait: { r2Key: "vq/characters/GNV-F03-S1/approved/master_portrait.png" },
    colour_sheet: { r2Key: "vq/characters/GNV-F03-S1/approved/colour_sheet.png" },
  },
  characterName: "Emberling", element: "Blaze", bodyShape: "small", colours: "ember", markings: "flame", eyes: "amber", tailAccessories: "none", locked: false,
}));
const CHAR = vi.hoisted(() => ({
  characterId: "GNV-F03-S2", familyId: "GNV-F03", stageNumber: 2, cardId: "GNV-091",
  descriptionStatus: "approved", evolvesFromCharacterId: "GNV-F03-S1",
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-F03-S2/approved/master_portrait.png" } },
  characterName: "Flamora", element: "Blaze", bodyShape: "quadrupedal", colours: "ember", markings: "flame", eyes: "amber", tailAccessories: "fire tail", locked: false,
}));

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async (id: string) => (id === PREV_CHAR.characterId ? PREV_CHAR : CHAR)),
    recordArtworkCandidate: vi.fn(async (input: Record<string, unknown>) => {
      const id = nextCandidateId.value++;
      const row = {
        id, characterId: input.characterId as string, status: "candidate",
        identityScore: null as number | null, identityBreakdown: null as unknown,
        r2Key: input.r2Key as string, referenceType: input.referenceType as string,
      };
      candidateStore.set(id, row);
      return row;
    }),
    recordAiGeneration: vi.fn(async () => 1),
    setArtworkCandidateIdentity: vi.fn(async (id: number, score: number | null, breakdown: unknown) => {
      const row = candidateStore.get(id);
      if (row) {
        row.identityScore = score;
        row.identityBreakdown = breakdown;
      }
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
    if (key === "vq/characters/GNV-F03-S2/approved/master_portrait.png") return MASTER_BUF;
    if (key === "vq/characters/GNV-F03-S1/approved/master_portrait.png") return PREV_MASTER_BUF;
    if (key === "vq/characters/GNV-F03-S1/approved/colour_sheet.png") return PREV_COLOUR_BUF;
    return null;
  }),
  getR2ObjectStream: vi.fn(async () => null),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";
import { evaluateIdentityGate, type IdentityGateBreakdown } from "../server/vault-quest/ai/identity-gate";

const q = (s: string, a: unknown[] = []) => (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";
let keyCounter = 0;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const ALL_PASS_TRAITS = { bodyShape: 92, colours: 92, markings: 92, eyes: 92, silhouette: 92, accessories: 92, familyTraits: 92, stageTraits: 92 };
const posePass = { difference: 82, verdict: "pass" as const, threshold: 55 };

const scored = (overallScore: number, breakdown: Record<string, number>) => ({
  score: overallScore,
  verdict: overallScore >= 70 ? ("pass" as const) : ("reject" as const),
  breakdown,
  threshold: 70,
  poseDiversity: posePass,
});

run("Action Reference IDENTITY-DRIFT gate — route wiring", () => {
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
    createSpy.mockImplementation(async () => ({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG_P, width: 200, height: 200, jobId: "job-drift" }));
    scoreSpy.mockReset();
    candidateStore.clear();
    nextCandidateId.value = 1;
    keyCounter++;
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES (\x27gen_master_portrait\x27,true,\x27test\x27),(\x27gen_action_pose\x27,true,\x27test\x27),(\x27gen_face_closeup\x27,true,\x27test\x27),(\x27gen_turnaround_sheet\x27,true,\x27test\x27),(\x27gen_colour_sheet\x27,true,\x27test\x27),(\x27gen_card_artwork\x27,true,\x27test\x27),(\x27gen_replacement\x27,true,\x27test\x27) ON CONFLICT (feature) DO UPDATE SET enabled = true", []); // Phase 2 correction A: gen_* now defaults OFF — these tests exercise OTHER gates and need every type enabled
    await q("DELETE FROM vq_feature_flags WHERE feature = 'auto_paid_retry'", []);
    await q("INSERT INTO vq_feature_flags (feature, enabled, updated_by) VALUES ('auto_paid_retry', true, 'test') ON CONFLICT (feature) DO UPDATE SET enabled = true", []); // item E: these tests exercise the EXISTING retry-on-failure mechanics, which now require the toggle explicitly ON
  });
  afterAll(async () => {
    await q("DELETE FROM vq_generation_requests", []);
    await q("DELETE FROM vq_config", []);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await (pool as unknown as { end: () => Promise<void> }).end();
  });

  it("overall above the auto-reject floor but Markings: Fail — visible, blocked from approval (422)", async () => {
    scoreSpy.mockResolvedValueOnce(scored(88, { ...ALL_PASS_TRAITS, markings: 55 }));
    scoreSpy.mockResolvedValueOnce(scored(88, { ...ALL_PASS_TRAITS, markings: 55 })); // retry still drifts
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-markings-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    const body = res.json as { candidateId: number };
    expect(candidateStore.get(body.candidateId)?.status).toBe("candidate"); // visible, not auto-rejected
    const approve = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/approve-candidate`, { candidateId: body.candidateId });
    expect(approve.status).toBe(422);
    expect((approve.json as { error: string }).error).toMatch(/changed the approved character identity/i);
    expect((approve.json as { reasons: string[] }).reasons).toContain("Markings: Fail");
  });

  it("overall above the auto-reject floor but Style (silhouette): Fail — blocked from approval (422)", async () => {
    scoreSpy.mockResolvedValueOnce(scored(88, { ...ALL_PASS_TRAITS, silhouette: 60 }));
    scoreSpy.mockResolvedValueOnce(scored(88, { ...ALL_PASS_TRAITS, silhouette: 60 }));
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-style-${keyCounter}`,
    });
    const body = res.json as { candidateId: number };
    const approve = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/approve-candidate`, { candidateId: body.candidateId });
    expect(approve.status).toBe(422);
    expect((approve.json as { reasons: string[] }).reasons).toContain("Style: Fail");
  });

  it("overall 75 (Needs Review) with clean traits still blocks approval — Needs Review is not approval-ready", async () => {
    scoreSpy.mockResolvedValueOnce(scored(75, { ...ALL_PASS_TRAITS }));
    scoreSpy.mockResolvedValueOnce(scored(75, { ...ALL_PASS_TRAITS }));
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-needsreview-${keyCounter}`,
    });
    const body = res.json as { candidateId: number };
    const approve = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/approve-candidate`, { candidateId: body.candidateId });
    expect(approve.status).toBe(422);
    expect((approve.json as { reasons: string[] }).reasons).toContain("Overall Identity: Needs Review");
  });

  it("all critical traits pass + overall pass + pose passes → NOT blocked by the identity gate (no retry needed)", async () => {
    scoreSpy.mockResolvedValueOnce(scored(94, { ...ALL_PASS_TRAITS }));
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-cleanpass-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1); // no retry needed — nothing drifted
    const body = res.json as { candidateId: number };
    const row = candidateStore.get(body.candidateId)!;
    expect(row.status).toBe("candidate"); // visible
    const gate = evaluateIdentityGate(row.identityScore, row.identityBreakdown as IdentityGateBreakdown);
    expect(gate.approvalReady).toBe(true);
  });

  it("attempt 1 identity-drift, attempt 2 clean — exactly ONE retry, SAME action category retained", async () => {
    scoreSpy.mockResolvedValueOnce(scored(88, { ...ALL_PASS_TRAITS, markings: 55 })); // attempt 1: drift
    scoreSpy.mockResolvedValueOnce(scored(94, { ...ALL_PASS_TRAITS })); // attempt 2: corrected
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-retry-ok-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2);
    const p1 = (createSpy.mock.calls[0][0] as { prompt: string }).prompt;
    const p2 = (createSpy.mock.calls[1][0] as { prompt: string }).prompt;
    // SAME action category retained (identity-only retry, no pose/novelty failure) —
    // extract the "SELECTED ACTION: depict the character X." fragment from each prompt.
    const cat1 = p1.match(/SELECTED ACTION: depict the character ([^.]+)\./)?.[1];
    const cat2 = p2.match(/SELECTED ACTION: depict the character ([^.]+)\./)?.[1];
    expect(cat1).toBeTruthy();
    expect(cat1).toBe(cat2);
    // The retry prompt carries the identity-correction suffix naming the failed trait.
    expect(p2).toMatch(/CRITICAL IDENTITY CORRECTION/);
    expect(p2).toMatch(/Markings/);
    const body = res.json as { candidateId: number };
    const row = candidateStore.get(body.candidateId)!;
    const gate = evaluateIdentityGate(row.identityScore, row.identityBreakdown as IdentityGateBreakdown);
    expect(gate.approvalReady).toBe(true); // the retry's corrected result is approval-ready
  });

  it("both attempts drift — capped at 2 provider calls, candidate stays VISIBLE, cannot be approved", async () => {
    scoreSpy.mockResolvedValueOnce(scored(88, { ...ALL_PASS_TRAITS, markings: 55 }));
    scoreSpy.mockResolvedValueOnce(scored(85, { ...ALL_PASS_TRAITS, markings: 58 }));
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-both-fail-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2); // never a 3rd call
    const body = res.json as { candidateId: number };
    expect(candidateStore.get(body.candidateId)?.status).toBe("candidate"); // visible, not hidden
    const approve = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/approve-candidate`, { candidateId: body.candidateId });
    expect(approve.status).toBe(422);
  });

  it("SPEND: identity-drift-only retry still prices the worst case (2 calls) up front", async () => {
    scoreSpy.mockResolvedValueOnce(scored(94, { ...ALL_PASS_TRAITS })); // clean first try — only 1 real call
    const idempotencyKey = `drift-spend-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const { rows } = await q("SELECT max_authorised_spend, charged_credits FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number(rows[0].max_authorised_spend)).toBe(2); // worst case still priced
    expect(Number(rows[0].charged_credits)).toBe(1);
  });

  it("ROOT CAUSE #2 FIX: Action Reference generation for a stage>1 character does NOT reference the previous stage's images — only its OWN Master", async () => {
    scoreSpy.mockResolvedValueOnce(scored(94, { ...ALL_PASS_TRAITS }));
    const res = await post(`/api/admin/vault-quest/characters/${CHAR.characterId}/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `drift-prevstage-excl-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    const refs = (createSpy.mock.calls[0][0] as { imageReferences?: Buffer[] }).imageReferences ?? [];
    expect(refs.some((b) => b.equals(MASTER_BUF))).toBe(true); // own Master present
    expect(refs.some((b) => b.equals(PREV_MASTER_BUF))).toBe(false); // prev stage's Master ABSENT
    expect(refs.some((b) => b.equals(PREV_COLOUR_BUF))).toBe(false); // prev stage's Colour Sheet ABSENT
  });
});
