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
const WHITE_PNG = vi.hoisted(() =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACD0lEQVR4nO3UMQ0AAAzDsPEnvaHIMckG0CvqLASmGAVhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYSEs/vBYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSExRYOwsoGniuviZgAAAAASUVORK5CYII=",
    "base64"
  )
);
// A real 1x1 PNG whose single pixel is black — validateStudioBackground rejects it
// outright (not a plain white/cream/light-grey backdrop). Stands in for a generated
// image with a scenic/environmental background for these tests.
const BAD_BG_PNG = vi.hoisted(() =>
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
);

const createSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    provider: "higgsfield" as const,
    model: "nano_banana",
    png: WHITE_PNG,
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
      png: WHITE_PNG,
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
  });

  it("background fails on BOTH attempts — hard-discarded: never uploaded, never a candidate row, 422, capped at 2 provider calls", async () => {
    createSpy.mockResolvedValue({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: BAD_BG_PNG,
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
    expect(uploadSpy).not.toHaveBeenCalled(); // discarded — never written to R2
    expect(candidateStore.size).toBe(0); // never recorded as a candidate row
  });

  it("background fails once, then passes on the automatic retry — accepted using exactly 2 provider calls", async () => {
    createSpy.mockResolvedValueOnce({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: BAD_BG_PNG,
      width: 1,
      height: 1,
      jobId: "job-bad-bg",
    });
    createSpy.mockResolvedValueOnce({
      provider: "higgsfield" as const,
      model: "nano_banana",
      png: WHITE_PNG,
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
      png: BAD_BG_PNG,
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
    expect(body.created.length).toBe(3);
    expect(body.bgRejected).toBe(0);
  });
});
