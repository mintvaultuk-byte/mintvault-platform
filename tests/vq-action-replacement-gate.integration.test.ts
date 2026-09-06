/**
 * Action Reference REPLACEMENT gate — END-TO-END route wiring. Mounts the REAL Vault
 * Quest admin router and mocks generateHiggsfieldArtwork + scoreCharacterIdentity so
 * each attempt is deterministic. This is the regression proof for the reported bug:
 * "Replace Action keeps producing essentially the same pose".
 *
 * Proves:
 *   - ROOT CAUSE FIX: when generating a REPLACEMENT Action pose, the character's
 *     currently-approved Action image is NOT passed to the provider as an
 *     image_reference (it used to be → the model reproduced it). The Master IS still
 *     passed (identity anchor).
 *   - the existing Action IS supplied to the novelty SCORER (comparison-only), via
 *     scoreCharacterIdentity's existingActionPng option, alongside the Master.
 *   - a candidate that passes pose-vs-Master but is too similar to the EXISTING Action
 *     (actionNovelty fail) retries once with a DIFFERENT action category, and if it
 *     then passes is accepted — exactly 2 provider calls.
 *   - a candidate that fails novelty on BOTH attempts stays visible, is capped at 2
 *     calls, and cannot be approved (422).
 *   - an explicit founder action category is honoured in the prompt.
 *   - a FIRST Action (no existing approved Action) still works: no existingActionPng,
 *     no actionNovelty, single call.
 *   - the pre-flight spend ceiling still prices the worst case (2 calls) for a replacement.
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

// A real solid-white 200x200 PNG — every generated candidate must clear the REAL
// (unmocked) validateStudioBackground before the novelty gate is reached.
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
// Distinct byte buffers for the approved Master vs Action so we can PROVE which is
// passed where. Content only matters for identity here (both mocked), never processed.
const MASTER_BUF = vi.hoisted(() => Buffer.from("MASTER-REFERENCE-IMAGE-BYTES"));
const ACTION_BUF = vi.hoisted(() => Buffer.from("EXISTING-ACTION-POSE-IMAGE-BYTES"));

const createSpy = vi.hoisted(() =>
  vi.fn(async () => ({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG, width: 200, height: 200, jobId: "job-action" }))
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

const candidateStore = vi.hoisted(() => new Map<number, { id: number; characterId: string; status: string; identityBreakdown: unknown; r2Key: string }>());
const nextCandidateId = vi.hoisted(() => ({ value: 1 }));

// Two characters: WITH an approved Action (replacement) and WITHOUT (first Action).
const CHAR_WITH_ACTION = vi.hoisted(() => ({
  characterId: "GNV-F01-S3", familyId: "GNV-F01", stageNumber: 3, cardId: "GNV-003",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: {
    master_portrait: { r2Key: "vq/characters/GNV-F01-S3/approved/master_portrait.png" },
    action_pose: { r2Key: "vq/characters/GNV-F01-S3/approved/action_pose.png" },
  },
  characterName: "Flamora", element: "Blaze", bodyShape: "quadrupedal", colours: "ember", markings: "flame", eyes: "amber", tailAccessories: "fire tail", locked: false,
}));
const CHAR_NO_ACTION = vi.hoisted(() => ({
  characterId: "GNV-F02-S1", familyId: "GNV-F02", stageNumber: 1, cardId: "GNV-050",
  descriptionStatus: "approved", evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-F02-S1/approved/master_portrait.png" } },
  characterName: "Aquabub", element: "Tide", bodyShape: "small", colours: "blue", markings: "wave", eyes: "cyan", tailAccessories: "none", locked: false,
}));

vi.mock("../server/vault-quest/storage", () => ({
  vqStorage: {
    getCharacter: vi.fn(async (id: string) => (id === CHAR_NO_ACTION.characterId ? CHAR_NO_ACTION : CHAR_WITH_ACTION)),
    recordArtworkCandidate: vi.fn(async (input: Record<string, unknown>) => {
      const id = nextCandidateId.value++;
      const row = { id, characterId: input.characterId as string, status: "candidate", identityBreakdown: null as unknown, r2Key: input.r2Key as string };
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

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async () => undefined),
  getR2Buffer: vi.fn(async (key: string) => {
    if (key.endsWith("/master_portrait.png")) return MASTER_BUF;
    if (key.endsWith("/action_pose.png")) return ACTION_BUF;
    return null;
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
  score: 92, verdict: "pass" as const, threshold: 70,
  breakdown: { bodyShape: 92, colours: 92, markings: 92, eyes: 92, silhouette: 92, accessories: 92, familyTraits: 92, stageTraits: 92 },
  poseDiversity: { difference: 82, verdict: "pass" as const, threshold: 55 },
  ...overrides,
});
const noveltyPass = (difference = 80) => ({ difference, verdict: "pass" as const, threshold: 65 });
const noveltyFail = (difference = 25) => ({ difference, verdict: "fail" as const, threshold: 65 });

run("Action Reference replacement gate — route wiring", () => {
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
    createSpy.mockResolvedValue({ provider: "higgsfield" as const, model: "nano_banana", png: await WHITE_PNG, width: 200, height: 200, jobId: "job-action" });
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

  it("ROOT-CAUSE FIX: the existing Action is NOT a provider reference; the Master IS; the existing Action goes only to the novelty scorer", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyPass(85) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `repl-refexcl-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Provider references: Master present, existing Action ABSENT.
    const refs = (createSpy.mock.calls[0][0] as { imageReferences?: Buffer[] }).imageReferences ?? [];
    expect(refs.some((b) => b.equals(MASTER_BUF))).toBe(true);
    expect(refs.some((b) => b.equals(ACTION_BUF))).toBe(false);

    // Scorer: existing Action supplied (comparison-only) + Master.
    const opts = scoreSpy.mock.calls[0][3] as { masterPng?: Buffer; existingActionPng?: Buffer };
    expect(opts.masterPng?.equals(MASTER_BUF)).toBe(true);
    expect(opts.existingActionPng?.equals(ACTION_BUF)).toBe(true);
  });

  it("novelty FAILS attempt 1, PASSES the retry — 2 calls, retry uses a DIFFERENT action category prompt", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyFail(25) }));
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyPass(78) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `repl-retry-ok-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2);
    // Category rotation: the two prompts differ and both name a selected action.
    const p1 = (createSpy.mock.calls[0][0] as { prompt: string }).prompt;
    const p2 = (createSpy.mock.calls[1][0] as { prompt: string }).prompt;
    expect(p1).toMatch(/SELECTED ACTION/);
    expect(p2).toMatch(/SELECTED ACTION/);
    expect(p1).not.toBe(p2);
  });

  it("novelty FAILS both attempts — capped at 2 calls, stays VISIBLE, cannot be approved (422)", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyFail(20) }));
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyFail(30) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `repl-both-fail-${keyCounter}`,
    });
    expect(res.status).toBe(201); // identity passed — not auto-rejected
    expect(createSpy).toHaveBeenCalledTimes(2);
    const body = res.json as { candidateId: number };
    expect(candidateStore.get(body.candidateId)?.status).toBe("candidate"); // visible

    const approve = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/approve-candidate`, { candidateId: body.candidateId });
    expect(approve.status).toBe(422);
    expect((approve.json as { error: string }).error).toMatch(/existing approved Action/i);
  });

  it("passes pose-vs-Master but fails novelty-vs-existing — blocked from approval", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: { difference: 90, verdict: "pass", threshold: 55 }, actionNovelty: noveltyFail(28) }));
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: { difference: 91, verdict: "pass", threshold: 55 }, actionNovelty: noveltyFail(33) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `repl-master-ok-novelty-fail-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    const body = res.json as { candidateId: number };
    const approve = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/approve-candidate`, { candidateId: body.candidateId });
    expect(approve.status).toBe(422);
  });

  it("an explicit founder action category is honoured in the prompt", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyPass(80) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", actionCategory: "roaring", idempotencyKey: `repl-explicit-cat-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    const prompt = (createSpy.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toMatch(/roaring/i);
    // stored on the candidate for the NEXT replacement's Auto exclusion
    const body = res.json as { candidateId: number };
    expect((candidateStore.get(body.candidateId)?.identityBreakdown as { actionCategory?: string })?.actionCategory).toBe("roaring");
  });

  it("FIRST Action (no existing approved Action) — no existingActionPng, no actionNovelty, single call", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass()); // poseDiversity pass, NO actionNovelty
    const res = await post(`/api/admin/vault-quest/characters/GNV-F02-S1/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey: `first-action-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const opts = scoreSpy.mock.calls[0][3] as { masterPng?: Buffer; existingActionPng?: Buffer };
    expect(opts.masterPng?.equals(MASTER_BUF)).toBe(true);
    expect(opts.existingActionPng).toBeUndefined(); // nothing to replace
  });

  it("SPEND: a replacement still prices the worst case (2 calls) up front", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ actionNovelty: noveltyPass(85) }));
    const idempotencyKey = `repl-spend-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S3/generate-artwork`, {
      referenceType: "action_pose", model: "nano_banana", idempotencyKey,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1); // only 1 real call
    const { rows } = await q("SELECT max_authorised_spend, charged_credits FROM vq_generation_requests WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number(rows[0].max_authorised_spend)).toBe(2); // worst case (2 × 1cr)
    expect(Number(rows[0].charged_credits)).toBe(1); // actual
  });
});
