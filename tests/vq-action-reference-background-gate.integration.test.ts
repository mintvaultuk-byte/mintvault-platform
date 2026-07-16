/**
 * Action Reference BACKGROUND fix — END-TO-END route wiring. Mounts the REAL Vault
 * Quest admin router and mocks the Higgsfield create + scoreCharacterIdentity calls
 * so background pass/fail can be controlled deterministically per attempt.
 *
 * Root cause this fixes: characterMasterArtworkPrompt() used to route action_pose
 * through the illustration-flavoured masterArtworkPrompt/DNA text (never through the
 * Master's strict studio-reference rules), and validateStudioBackground() was only
 * ever invoked for master_portrait — so Action References never had their background
 * checked at all and routinely came back as scenic/environmental illustrations.
 *
 * Proves:
 *   - the action_pose prompt shares the Master's exact BACKGROUND/lighting/framing/
 *     negative-list rules, differing ONLY in the pose section
 *   - a background that fails validation on BOTH attempts is hard-discarded — never
 *     uploaded, never recorded as a candidate, 422, capped at 2 provider calls
 *     (mirrors the Master Reference's existing precedent exactly)
 *   - a background that fails once then passes on retry is accepted normally,
 *     using exactly 2 provider calls
 *   - the background check is a hard gate checked BEFORE pose-diversity: a bad
 *     background with an approved Master present is discarded WITHOUT ever calling
 *     scoreCharacterIdentity (no wasted vision call on an already-defective image)
 *   - a background that passes immediately still runs the existing pose-diversity
 *     gate afterward — the new gate doesn't disturb the pre-existing one
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
  const ok =
    (u.hostname === "127.0.0.1" || u.hostname === "localhost") &&
    u.port === "55432" &&
    u.pathname === "/mintvault_vq_phase10_local";
  if (!ok)
    throw new Error(
      `REFUSED: TEST_DATABASE_URL must be the local throwaway DB, got ${u.hostname}:${u.port}${u.pathname}`
    );
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

// A real solid-white 200x200 PNG — clears the REAL (unmocked) validateStudioBackground.
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
// A real 200x200 PNG with a saturated green edge band (fails validateStudioBackground's
// "plain white/cream/light-grey" check) but plenty of interior variance (passes the
// image-integrity check, which runs before the background check in the pipeline).
// Stands in for a generated image with a scenic/environmental background for these tests.
const BAD_BG_PNG = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require("sharp");
  const width = 200, height = 200;
  const buf = Buffer.alloc(width * height * 3);
  const border = 24;
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inBorder = x < border || x >= width - border || y < border || y >= height - border;
      if (inBorder) { buf[i] = 40; buf[i + 1] = 130; buf[i + 2] = 50; }
      else {
        const v = Math.max(150, Math.min(250, 200 + Math.round((rand() - 0.5) * 100)));
        buf[i] = v; buf[i + 1] = Math.max(0, Math.min(255, v - 15)); buf[i + 2] = Math.max(0, Math.min(255, v - 30));
      }
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
});

// A real 200x200 PNG on a PLAIN near-white studio backdrop whose subject sprawls to the
// right edge — FAILS the raw 5% gate, but the deterministic local finish CAN isolate the
// subject and re-centre it on white. The exact production case: right creature, bad edges.
const CORRECTABLE_PNG = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sharp = require("sharp");
  const width = 200, height = 200;
  const buf = Buffer.alloc(width * height * 3);
  const disc = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) <= r;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      let r = 248, g = 248, b = 248; // plain near-white studio backdrop
      if (disc(x, y, 92, 100, 40) || (y > 64 && y < 136 && x > 92)) { r = 190; g = 60; b = 55; } // body + a tall arm reaching the right edge (fails the raw 5% gate)
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }
  return sharp(buf, { raw: { width, height, channels: 3 } }).png().toBuffer();
});

const createSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    provider: "higgsfield" as const,
    model: "nano_banana",
    png: await WHITE_PNG,
    width: 200,
    height: 200,
    jobId: "job-bg-gate",
  }))
);
vi.mock("../server/vault-quest/ai/higgsfield", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    generateHiggsfieldArtwork: createSpy,
    higgsfieldConnection: () => ({ connected: true, model: "nano_banana", note: "" }),
  };
});

const scoreSpy = vi.hoisted(() => vi.fn());
vi.mock("../server/vault-quest/ai/identity", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, scoreCharacterIdentity: scoreSpy };
});

const candidateStore = vi.hoisted(
  () =>
    new Map<number, { id: number; characterId: string; status: string; identityBreakdown: unknown; r2Key: string }>()
);
const nextCandidateId = vi.hoisted(() => ({ value: 1 }));

// Bootstrap subject: NO approved Master yet — isolates the background gate from the
// pose-diversity gate (poseGateActive requires an approved Master to diff against).
const CHARACTER_NO_MASTER = vi.hoisted(() => ({
  characterId: "GNV-F02-S1",
  familyId: "GNV-F02",
  stageNumber: 1,
  cardId: "GNV-002",
  descriptionStatus: "approved",
  evolvesFromCharacterId: null,
  referencePack: null,
  characterName: "Bootstrap Subject",
  element: "Water",
  bodyShape: "small",
  colours: "blue/teal",
  markings: "fin stripes",
  eyes: "green",
  tailAccessories: "none",
  characterDna: "a small water creature",
  visualDescription: "a small blue water creature with fin stripes",
  locked: false,
}));

// Subject WITH an approved Master — exercises the background-gate-then-pose-gate
// ordering (background must be checked FIRST, before any pose-diversity scoring).
const CHARACTER_WITH_MASTER = vi.hoisted(() => ({
  characterId: "GNV-F03-S1",
  familyId: "GNV-F03",
  stageNumber: 1,
  cardId: "GNV-003",
  descriptionStatus: "approved",
  evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-F03-S1/approved/master_portrait.png" } },
  characterName: "Master-Backed Subject",
  element: "Flame",
  bodyShape: "small",
  colours: "red/orange",
  markings: "flame tip tail",
  eyes: "amber",
  tailAccessories: "none",
  locked: false,
}));

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async (characterId: string) =>
      characterId === CHARACTER_WITH_MASTER.characterId ? CHARACTER_WITH_MASTER : CHARACTER_NO_MASTER
    ),
    recordArtworkCandidate: vi.fn(async (input: Record<string, unknown>) => {
      const id = nextCandidateId.value++;
      const row = {
        id,
        characterId: input.characterId as string,
        status: "candidate",
        identityBreakdown: null,
        r2Key: input.r2Key as string,
      };
      candidateStore.set(id, row);
      return row;
    }),
    recordAiGeneration: vi.fn(async () => 1),
    setArtworkCandidateIdentity: vi.fn(async (id: number, _score: number, breakdown: unknown) => {
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

const uploadSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../server/r2", () => ({
  uploadToR2: uploadSpy,
  getR2Buffer: vi.fn(async (key: string) =>
    key === CHARACTER_WITH_MASTER.referencePack.master_portrait.r2Key ? WHITE_PNG : null
  ),
  getR2ObjectStream: vi.fn(async () => null),
}));

const run = TEST_URL ? describe : describe.skip;

import { registerVaultQuestAdminRoutes } from "../server/routes/vault-quest-admin";
import { pool } from "../server/db";

const q = (s: string, a: unknown[] = []) =>
  (pool as unknown as { query: (s: string, a: unknown[]) => Promise<{ rows: unknown[] }> }).query(s, a);

let server: Server;
let base = "";
let keyCounter = 0;

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const identityPass = (overrides: Record<string, unknown> = {}) => ({
  score: 92,
  verdict: "pass" as const,
  threshold: 70,
  breakdown: {
    bodyShape: 92,
    colours: 92,
    markings: 92,
    eyes: 92,
    silhouette: 92,
    accessories: 92,
    familyTraits: 92,
    stageTraits: 92,
  },
  ...overrides,
});
const posePass = (difference = 82) => ({ difference, verdict: "pass" as const, threshold: 55 });

run("Action Reference background gate — route wiring", () => {
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
    createSpy.mockResolvedValue({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await WHITE_PNG,
      width: 200,
      height: 200,
      jobId: "job-bg-gate",
    });
    scoreSpy.mockReset();
    uploadSpy.mockClear();
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

  it("prompt shares the Master's exact background/lighting/framing/negative rules — only the pose section differs", async () => {
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_NO_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `prompt-shape-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const prompt = (createSpy.mock.calls[0][0] as { prompt: string }).prompt;

    // Shared strict studio rules, verbatim from the Master's prompt.
    expect(prompt).toMatch(/BACKGROUND \(must be absolutely plain\)/);
    expect(prompt).toMatch(/no scenery, no forests, no rocks/);
    expect(prompt).toMatch(/no smoke, no particles, no atmospheric effects, no environmental lighting/);
    expect(prompt).toMatch(
      /no rim lighting, no dramatic or cinematic lighting, no environmental lighting, no cinematic depth-of-field/
    );
    expect(prompt).toMatch(/no scenery; no forests; no rocks; no environment/);
    expect(prompt).toMatch(/production reference library, NOT a finished illustration and NOT a dramatic action scene/);
    expect(prompt).toMatch(/professional character turnaround\/reference sheet/);

    // The ONLY intentional difference: the pose section itself.
    expect(prompt).toMatch(/caught mid-action on the SAME plain studio backdrop as the Master Reference/);
    expect(prompt).toMatch(/Match the Master's exact framing and camera distance/);

    // Must NOT have fallen through to the old illustration-flavoured/bootstrap-fallback prompt path.
    expect(prompt).not.toMatch(/Standalone original character artwork/);

    // Action-pose studio-containment strengthening (this fix): #1 pure white studio bg,
    // #2 no scenery/gradient/texture/edge-effects, full containment + white margin,
    // #3 identity preserved (only pose/expression/camera/movement change).
    expect(prompt).toMatch(/STUDIO CONTAINMENT/);
    expect(prompt).toMatch(/pure solid white/i);
    expect(prompt).toMatch(/generous empty margin of plain white on all four sides/);
    expect(prompt).toMatch(/may touch, cross or even approach any edge/);
    expect(prompt).toMatch(/no gradient, no texture, no vignette/);
    expect(prompt).toMatch(/motion lines, speed streaks, energy trails/);
    expect(prompt).toMatch(/none reaching or touching the frame edges/);
    expect(prompt).toMatch(/Preserve the exact approved character identity — change ONLY pose, expression, camera angle and movement/);
  });

  it("background fails on BOTH attempts — hard-discarded: never uploaded, never a candidate row, 422, capped at 2 provider calls", async () => {
    createSpy.mockResolvedValue({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await BAD_BG_PNG,
      width: 1,
      height: 1,
      jobId: "job-bad-bg",
    });
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_NO_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `bg-both-fail-${keyCounter}`,
    });
    expect(res.status).toBe(422);
    expect((res.json as { rejected?: boolean; error?: string }).rejected).toBe(true);
    expect((res.json as { error?: string }).error).toMatch(/studio background rejected/i);
    expect(createSpy).toHaveBeenCalledTimes(2); // one retry, then give up — never a 3rd
    // The rejected source is now PRESERVED privately in quarantine (a credit was spent),
    // but is NEVER written as an approved candidate. The only upload is the quarantine key.
    for (const call of uploadSpy.mock.calls) expect(String(call[0])).toMatch(/\/quarantine\//);
    expect(candidateStore.size).toBe(0); // never recorded as a candidate row
  });

  it("auto_paid_retry OFF: a background rejection makes EXACTLY ONE provider call and returns structured 422 (no silent second charge)", async () => {
    // Default-safe state: the owner has NOT enabled automatic paid retry.
    await q("UPDATE vq_feature_flags SET enabled = false WHERE feature = 'auto_paid_retry'", []);
    createSpy.mockResolvedValue({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await BAD_BG_PNG,
      width: 1,
      height: 1,
      jobId: "job-bad-bg-noretry",
    });
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_NO_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `bg-noretry-${keyCounter}`,
    });
    const body = res.json as {
      rejected?: boolean;
      rejectionKind?: string;
      error?: string;
      backgroundOffFraction?: number;
      backgroundThreshold?: number;
      providerCreditUsed?: boolean;
      autoRetried?: boolean;
    };
    expect(res.status).toBe(422);
    expect(body.rejected).toBe(true);
    expect(body.rejectionKind).toBe("studio_background");
    expect(body.error).toMatch(/studio background rejected/i);
    // Structured, founder-facing evidence: measured fraction, exact threshold, credit note.
    expect(typeof body.backgroundOffFraction).toBe("number");
    expect(body.backgroundOffFraction).toBeGreaterThan(0.05);
    expect(body.backgroundThreshold).toBe(0.05);
    expect(body.providerCreditUsed).toBe(true);
    expect(body.autoRetried).toBe(false);
    // The decisive spend-safety assertion: exactly ONE paid provider call — no auto-retry.
    expect(createSpy).toHaveBeenCalledTimes(1);
    // Rejected source preserved in private quarantine only — never as a candidate.
    for (const call of uploadSpy.mock.calls) expect(String(call[0])).toMatch(/\/quarantine\//);
    expect(candidateStore.size).toBe(0);
  });

  it("DETERMINISTIC LOCAL FINISH: a raw image that fails the gate is corrected locally into a candidate — ZERO extra provider calls, zero extra credits", async () => {
    await q("UPDATE vq_feature_flags SET enabled = false WHERE feature = 'auto_paid_retry'", []); // default-safe
    createSpy.mockResolvedValue({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await CORRECTABLE_PNG, // near-white backdrop, subject to the edge → fails raw gate
      width: 200,
      height: 200,
      jobId: "job-correctable",
    });
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_NO_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `finish-ok-${keyCounter}`,
    });
    const body = res.json as { backgroundCorrected?: boolean; candidateId?: number; studioFinish?: { method?: string; edgeOffAfter?: number } };
    expect(res.status).toBe(201); // corrected → a real candidate, not a rejection
    expect(body.backgroundCorrected).toBe(true);
    expect(body.studioFinish?.method).toBe("chroma");
    expect(body.studioFinish?.edgeOffAfter).toBeLessThanOrEqual(5); // final passes the UNCHANGED 5% gate
    // THE decisive proof: the local finish spent NO extra provider call — one create only.
    expect(createSpy).toHaveBeenCalledTimes(1);
    // The CLEANED image was written as a real candidate (a candidate key, not quarantine).
    expect(candidateStore.size).toBe(1);
    expect(uploadSpy.mock.calls.some((c) => /\/candidates?\//.test(String(c[0])) || !/\/quarantine\//.test(String(c[0])))).toBe(true);
    for (const call of uploadSpy.mock.calls) expect(String(call[0])).not.toMatch(/\/quarantine\//); // nothing quarantined on success
  });

  it("background fails once, then passes on the automatic retry — accepted using exactly 2 provider calls", async () => {
    createSpy.mockResolvedValueOnce({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await BAD_BG_PNG,
      width: 1,
      height: 1,
      jobId: "job-bad-bg",
    });
    createSpy.mockResolvedValueOnce({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await WHITE_PNG,
      width: 200,
      height: 200,
      jobId: "job-good-bg",
    });
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_NO_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `bg-retry-ok-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(uploadSpy).toHaveBeenCalledTimes(1); // only the passing attempt is uploaded

    // The 2nd attempt's prompt carries the stricter background suffix.
    const retryPrompt = (createSpy.mock.calls[1][0] as { prompt: string }).prompt;
    expect(retryPrompt).toMatch(/CRITICAL: the previous attempt had an unacceptable background/);
  });

  it("background check is a HARD GATE checked BEFORE pose-diversity: a bad background with an approved Master present is discarded WITHOUT ever scoring pose", async () => {
    createSpy.mockResolvedValue({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: await BAD_BG_PNG,
      width: 1,
      height: 1,
      jobId: "job-bad-bg-master",
    });
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_WITH_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `bg-priority-${keyCounter}`,
    });
    expect(res.status).toBe(422);
    expect((res.json as { rejected?: boolean }).rejected).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2); // capped, same as the no-Master case
    expect(scoreSpy).not.toHaveBeenCalled(); // never wasted a vision call on a defective background
    expect(candidateStore.size).toBe(0);
  });

  it("background passes immediately — the existing pose-diversity gate still runs afterward, unaffected", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: posePass(88) }));
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_WITH_MASTER.characterId}/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `bg-pass-pose-runs-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1); // background passed AND pose passed first try — no retry needed
    expect(scoreSpy).toHaveBeenCalledTimes(1);
    const body = res.json as { poseDiversity?: { verdict: string } };
    expect(body.poseDiversity?.verdict).toBe("pass");
  });

  it("Master Reference's own background gate is completely unchanged by this fix (regression)", async () => {
    scoreSpy.mockResolvedValue(identityPass());
    const res = await post(`/api/admin/vault-quest/characters/${CHARACTER_NO_MASTER.characterId}/generate-artwork`, {
      referenceType: "master_portrait",
      model: "nano_banana",
      idempotencyKey: `master-regression-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    const body = res.json as { created: unknown[]; bgRejected: number };
    expect(body.created.length).toBe(2); // Master now produces 2 candidates (founder decision)
    expect(body.bgRejected).toBe(0);
  });
});
