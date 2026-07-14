/**
 * Action Reference pose-diversity gate — END-TO-END route wiring. Mounts the REAL
 * Vault Quest admin router (not a mock of the route) and mocks scoreCharacterIdentity
 * directly (its own vision-call behaviour is covered by
 * tests/vq-identity-pose-scoring.test.ts) so each attempt's identity+pose verdict is
 * fully controlled and deterministic. Proves:
 *   - a pose that fails on attempt 1 but passes on the automatic retry is accepted,
 *     using exactly 2 provider calls (the retry, not more)
 *   - a pose that fails on BOTH attempts stays visible (NOT hidden like an identity
 *     failure) with a Pose Diversity: Fail verdict, is capped at 2 provider calls
 *     (never a 3rd), and cannot be approved (422)
 *   - a genuinely dynamic pose that passes immediately costs only 1 provider call —
 *     no wasted retry
 *   - identity failure (existing gate) is completely unaffected: still auto-rejected
 *     and hidden, regardless of the pose-diversity verdict
 *   - Master Reference generation never invokes the pose gate at all (no masterPng
 *     threaded through, existing single/retry-on-background-only behaviour intact)
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

const TINY_PNG = vi.hoisted(() =>
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
);
// A real solid-white 200x200 PNG. Action Reference now ALSO runs the REAL (unmocked)
// validateStudioBackground — same as Master — so every generated candidate in this
// file (pose-diversity is a SEPARATE gate this file specifically isolates) must clear
// the background check first, or every attempt would be background-rejected before
// the pose-diversity mock ever gets exercised. TINY_PNG stays in use for the approved
// Master's OWN reference image fed back in as an image_reference (never itself
// background-validated — only freshly generated output is).
const WHITE_PNG = vi.hoisted(() =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACD0lEQVR4nO3UMQ0AAAzDsPEnvaHIMckG0CvqLASmGAVhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYZEQFglhkRAWCWGREBYJYSEs/vBYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSERUJYJIRFQlgkhEVCWCSExRYOwsoGniuviZgAAAAASUVORK5CYII=",
    "base64"
  )
);

const createSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    provider: "higgsfield" as const,
    model: "nano_banana",
    png: WHITE_PNG,
    width: 200,
    height: 200,
    jobId: "job-pose-gate",
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

const CHARACTER = vi.hoisted(() => ({
  characterId: "GNV-F01-S1",
  familyId: "GNV-F01",
  stageNumber: 1,
  cardId: "GNV-001",
  descriptionStatus: "approved",
  evolvesFromCharacterId: null,
  referencePack: { master_portrait: { r2Key: "vq/characters/GNV-F01-S1/approved/master_portrait.png" } },
  characterName: "Pose Gate Subject",
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
    getCharacter: vi.fn(async () => CHARACTER),
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

vi.mock("../server/r2", () => ({
  uploadToR2: vi.fn(async () => undefined),
  getR2Buffer: vi.fn(async (key: string) => (key === CHARACTER.referencePack.master_portrait.r2Key ? TINY_PNG : null)),
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
const poseFail = (difference = 15) => ({ difference, verdict: "fail" as const, threshold: 55 });
const posePass = (difference = 82) => ({ difference, verdict: "pass" as const, threshold: 55 });

run("Action Reference pose-diversity gate — route wiring", () => {
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
      jobId: "job-pose-gate",
    });
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

  it("pose FAILS on attempt 1, PASSES on the automatic retry — accepted, exactly 2 provider calls", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: poseFail() }));
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: posePass() }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `pose-retry-ok-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(2); // discarded attempt 1 + accepted attempt 2
    expect(scoreSpy).toHaveBeenCalledTimes(2);
    const body = res.json as { poseDiversity?: { verdict: string } };
    expect(body.poseDiversity?.verdict).toBe("pass");
  });

  it("pose FAILS on BOTH attempts — capped at 2 provider calls, stays VISIBLE (not auto-rejected), cannot be approved", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: poseFail(10) }));
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: poseFail(20) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `pose-both-fail-${keyCounter}`,
    });
    expect(res.status).toBe(201); // NOT auto-rejected — identity passed both times, only pose failed
    expect(createSpy).toHaveBeenCalledTimes(2); // capped — never a 3rd generation chasing diversity
    const body = res.json as { candidateId: number; poseDiversity?: { verdict: string; difference: number } };
    expect(body.poseDiversity?.verdict).toBe("fail");
    expect(body.poseDiversity?.difference).toBe(20); // the LAST attempt's score, not the first

    // Still visible in the candidate list (unlike an identity failure)
    const stored = candidateStore.get(body.candidateId);
    expect(stored?.status).toBe("candidate");

    // But blocked from approval — the REAL guard, not just a client-side disabled button
    const approve = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/approve-candidate`, {
      candidateId: body.candidateId,
    });
    expect(approve.status).toBe(422);
    expect((approve.json as { error: string }).error).toMatch(/Pose Diversity: Fail/i);
  });

  it("a genuinely dynamic pose passes immediately — only 1 provider call, no wasted retry", async () => {
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: posePass(88) }));
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `pose-dynamic-${keyCounter}`,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(scoreSpy).toHaveBeenCalledTimes(1);
  });

  it("SPEND ESTIMATE prices the WORST CASE (2 calls) up front, but the ACTUAL charge reflects only what really happened (1 call)", async () => {
    // Pose passes on the very first try — only 1 real provider call, so the actual
    // charge must be 1 credit. But the pre-flight/D10 authorised-spend ceiling must
    // have been reserved for 2 credits (the worst case this request could have cost
    // had the pose failed and needed a retry) — otherwise a genuine retry later in
    // the SAME request could exceed what was actually authorised.
    scoreSpy.mockResolvedValueOnce(identityPass({ poseDiversity: posePass(90) }));
    const idempotencyKey = `pose-spend-estimate-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey,
    });
    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledTimes(1); // only 1 real call happened

    const { rows } = await q(
      "SELECT max_authorised_spend, charged_credits FROM vq_generation_requests WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    expect(Number(rows[0].max_authorised_spend)).toBe(2); // priced for the worst case (2 × 1cr nano_banana)
    expect(Number(rows[0].charged_credits)).toBe(1); // but only actually charged for what happened
  });

  it("a reference type with NO retry path (e.g. no approved Master yet) is priced at the normal 1x rate, not doubled", async () => {
    // Same character, but face_closeup is never pose-gated regardless of Master state.
    scoreSpy.mockResolvedValueOnce(identityPass());
    const idempotencyKey = `no-pose-gate-normal-price-${keyCounter}`;
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "face_closeup",
      model: "nano_banana",
      idempotencyKey,
    });
    expect(res.status).toBe(201);
    const { rows } = await q("SELECT max_authorised_spend FROM vq_generation_requests WHERE idempotency_key = $1", [
      idempotencyKey,
    ]);
    expect(Number(rows[0].max_authorised_spend)).toBe(1); // NOT doubled — this reference type can never retry
  });

  it("identity FAILS while pose PASSES — existing identity gate unaffected: still auto-rejected and hidden", async () => {
    scoreSpy.mockResolvedValueOnce({
      score: 40,
      verdict: "reject",
      threshold: 70,
      breakdown: {
        bodyShape: 40,
        colours: 35,
        markings: 30,
        eyes: 45,
        silhouette: 40,
        accessories: 50,
        familyTraits: 40,
        stageTraits: 45,
      },
      poseDiversity: posePass(90),
    });
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "action_pose",
      model: "nano_banana",
      idempotencyKey: `identity-fail-${keyCounter}`,
    });
    expect(res.status).toBe(422);
    const body = res.json as { autoRejected: boolean; identityScore: number };
    expect(body.autoRejected).toBe(true);
    expect(body.identityScore).toBe(40);
  });

  it("Master Reference generation never invokes the pose gate — scoreCharacterIdentity called with NO masterPng", async () => {
    scoreSpy.mockResolvedValue(identityPass()); // used by the post-upload scoreAndGateCandidate path, not the pose retry loop
    const res = await post(`/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork`, {
      referenceType: "master_portrait",
      model: "nano_banana",
      idempotencyKey: `master-unaffected-${keyCounter}`,
    });
    // Master always makes 2 candidates (route-enforced) — just confirm it completes and
    // the pose gate was never exercised: no call ever received a masterPng option.
    expect(res.status).toBe(201);
    const body = res.json as { created: unknown[]; bgRejected: number };
    expect(body.created.length).toBe(2); // both passed the (real, unmocked) background check
    expect(body.bgRejected).toBe(0);
    expect(scoreSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of scoreSpy.mock.calls) {
      const opts = call[3] as { masterPng?: Buffer } | undefined;
      expect(opts?.masterPng).toBeUndefined();
    }
  });
});
